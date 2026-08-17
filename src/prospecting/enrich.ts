/**
 * Contact enrichment — for each queued prospect, one focused web search to find
 * the best person to pitch (founder / MD / executive producer / head of
 * production) and their published email.
 *
 * Honesty rules are the same as discovery: a name, role or email is only
 * reported if it is actually published on a page the search found, and the
 * page URL is recorded as the source. A guessed email poisons the sending
 * domain's reputation, so "nothing found" is a valid, recorded outcome —
 * enriched_at is set either way so a company is not re-searched every run.
 */
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { recordEvent } from '../db/events.js';
import { completeWithWebSearch, extractJson } from '../anthropic.js';

const elog = log.child('enrich');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EnrichedContact {
  contactName: string | null;
  contactRole: string | null;
  contactEmail: string | null;
  contactPageUrl: string | null;
  /** The page where the name/email was actually published. */
  sourceUrl: string | null;
}

const SYSTEM = `You research who to contact at a specific company, using web search, for a small UK studio's new-business outreach. You are rigorous about evidence.

Hard rules:
- Only report a person, role or email address you actually found published on a page in your search results (their team/about/contact page, a directory listing, a published interview). NEVER guess or construct an email address — a fabricated address damages the sender's reputation. Missing information is a valid answer.
- Prefer a named decision-maker (founder, managing director, executive producer, head of production) over a generic role inbox (info@/hello@). If only a role inbox is published, report that.
- "sourceUrl" must be the page where the name/email actually appears.

Return ONLY JSON: {"contactName": "... or null", "contactRole": "... or null", "contactEmail": "... or null", "contactPageUrl": "https://... or null", "sourceUrl": "https://... or null"}. No preamble.`;

/** Validate the model's answer. Exported for tests. */
export function parseContact(text: string): EnrichedContact {
  let raw: Record<string, unknown>;
  try {
    raw = extractJson<Record<string, unknown>>(text);
  } catch {
    return { contactName: null, contactRole: null, contactEmail: null, contactPageUrl: null, sourceUrl: null };
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  const url = (v: unknown) => {
    const s = str(v);
    return s && /^https?:\/\/\S+\.\S+/.test(s) ? s : null;
  };
  const sourceUrl = url(raw.sourceUrl);
  let contactEmail = str(raw.contactEmail);
  if (contactEmail && !EMAIL_RE.test(contactEmail)) contactEmail = null;
  // The honesty rule, enforced: an email with no published source is a guess.
  if (contactEmail && !sourceUrl) contactEmail = null;
  return {
    contactName: str(raw.contactName),
    contactRole: str(raw.contactRole),
    contactEmail,
    contactPageUrl: url(raw.contactPageUrl),
    sourceUrl,
  };
}

const SYSTEM_INSTAGRAM = `You research a specific Instagram account, using web search, for a small UK video studio deciding whether the account is a prospective client. You are rigorous about evidence.

Hard rules:
- Only report facts you actually found published (their Instagram bio as surfaced in search results, their website, directory pages, published interviews). NEVER guess or construct an email address — a fabricated address damages the sender's reputation. Missing information is a valid answer.
- Work out who or what the account is: a company, a freelancer, or a private individual. If it is a private individual with no business relevance, set "category" to "individual" and leave the rest null.
- Prefer a named decision-maker over a generic role inbox; report whichever is actually published.
- "sourceUrl" must be the page where the contact details actually appear.

Return ONLY JSON: {"company": "... or null", "website": "https://... or null", "location": "... or null", "category": "prodco|agency|post house|brand studio|freelancer|individual|other", "whyFit": "one sentence on what they make / why they might hire a studio, or null", "contactName": "... or null", "contactRole": "... or null", "contactEmail": "... or null", "contactPageUrl": "https://... or null", "sourceUrl": "https://... or null"}. No preamble.`;

export interface IgResearch extends EnrichedContact {
  company: string | null;
  website: string | null;
  location: string | null;
  category: string | null;
  whyFit: string | null;
}

/** Validate the Instagram-research answer. Exported for tests. */
export function parseIgResearch(text: string): IgResearch {
  const contact = parseContact(text);
  let raw: Record<string, unknown> = {};
  try {
    raw = extractJson<Record<string, unknown>>(text);
  } catch {
    // fall through with nulls
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  const website = str(raw.website);
  return {
    ...contact,
    company: str(raw.company),
    website: website && /^https?:\/\//.test(website) ? website : null,
    location: str(raw.location),
    category: str(raw.category),
    whyFit: str(raw.whyFit),
  };
}

interface CandidateRow {
  id: string;
  company: string;
  website: string | null;
  location: string | null;
  category: string | null;
  track: string;
  origin: string;
  evidence_url: string;
}

export interface EnrichSummary {
  looked: number;
  withEmail: number;
  withName: number;
  nothingFound: number;
}

/**
 * Enrich queued candidates that have no contact email and have not been
 * looked up yet. Bounded per run so a big backlog cannot stall the cycle.
 */
export async function enrichCandidates(limit = 15): Promise<EnrichSummary> {
  const summary: EnrichSummary = { looked: 0, withEmail: 0, withName: 0, nothingFound: 0 };
  if (!config.anthropic.apiKey) return summary;

  const rows = db()
    .prepare(
      `SELECT id, company, website, location, category, track, origin, evidence_url FROM prospects
       WHERE status = 'candidate' AND contact_email IS NULL AND enriched_at IS NULL
       ORDER BY discovered_at ASC LIMIT ?`,
    )
    .all(limit) as CandidateRow[];

  for (const p of rows) {
    let contact: EnrichedContact;
    let ig: IgResearch | null = null;
    try {
      if (p.origin === 'instagram') {
        const handle = p.company.replace(/^@/, '');
        const text = await completeWithWebSearch({
          system: SYSTEM_INSTAGRAM,
          user: `Instagram account: @${handle} (profile: ${p.evidence_url}). They engaged with a UK virtual production studio's Instagram. Work out who they are, and find the best person and published contact details to pitch video production / VFX services to. Return the JSON only.`,
          maxSearches: 5,
          maxTokens: 4096,
          timeoutMs: 180_000,
        });
        ig = parseIgResearch(text);
        contact = ig;
      } else {
        const service = p.track === 'VFX' ? 'VFX/post-production work' : 'studio shoots and video production services';
        const user = `Company: ${p.company}${p.website ? ` — website ${p.website}` : ''}${p.location ? ` — ${p.location}` : ''} (${p.category ?? 'production company'}).

Find the best person there to pitch ${service} to, and their published contact details. Check the company's team/about/contact pages and any published directory or interview pages. Return the JSON only.`;
        const text = await completeWithWebSearch({
          system: SYSTEM,
          user,
          maxSearches: 4,
          maxTokens: 4096,
          timeoutMs: 180_000,
        });
        contact = parseContact(text);
      }
    } catch (err) {
      // One slow/failed lookup must not sink the rest; leave enriched_at NULL
      // so this company is retried next run.
      elog.warn('enrichment lookup failed — will retry next run', {
        company: p.company,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const now = new Date().toISOString();
    if (ig) {
      // Instagram intake: the research also fills in who the account IS.
      // The domain has a unique index, so only claim it if nobody else has.
      const { normaliseDomain } = await import('./discover.js');
      let domain = normaliseDomain(ig.website);
      if (domain) {
        const taken = db().prepare('SELECT 1 FROM prospects WHERE domain = ? AND id != ?').get(domain, p.id);
        if (taken) domain = null;
      }
      db()
        .prepare(
          `UPDATE prospects SET
             company = COALESCE(?, company), website = COALESCE(?, website), domain = COALESCE(?, domain),
             location = COALESCE(?, location), category = COALESCE(?, category),
             why_fit = COALESCE(?, why_fit),
             contact_name = ?, contact_role = ?, contact_email = ?,
             contact_page_url = ?, contact_source_url = ?,
             enriched_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          ig.company, ig.website, domain, ig.location, ig.category, ig.whyFit,
          ig.contactName, ig.contactRole, ig.contactEmail, ig.contactPageUrl, ig.sourceUrl,
          now, now, p.id,
        );
    } else {
      db()
        .prepare(
          `UPDATE prospects SET
             contact_name = COALESCE(?, contact_name),
             contact_role = ?,
             contact_email = ?,
             contact_page_url = COALESCE(?, contact_page_url),
             contact_source_url = ?,
             enriched_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(contact.contactName, contact.contactRole, contact.contactEmail, contact.contactPageUrl, contact.sourceUrl, now, now, p.id);
    }

    summary.looked++;
    if (contact.contactEmail) summary.withEmail++;
    if (contact.contactName) summary.withName++;
    if (!contact.contactEmail && !contact.contactName) summary.nothingFound++;

    recordEvent({
      type: 'prospect.enriched',
      trigger: 'enrichment',
      reason: contact.contactEmail
        ? `Found contact for ${p.company}: ${contact.contactName ?? 'role inbox'}${contact.contactRole ? ` (${contact.contactRole})` : ''} <${contact.contactEmail}>`
        : contact.contactName
          ? `Found ${contact.contactName}${contact.contactRole ? ` (${contact.contactRole})` : ''} at ${p.company} — no published email`
          : `No published contact found for ${p.company}`,
      data: { prospectId: p.id, company: p.company, sourceUrl: contact.sourceUrl },
    });
    elog.info('candidate enriched', {
      company: p.company,
      name: contact.contactName ?? '—',
      email: contact.contactEmail ?? '—',
    });
  }

  if (summary.looked > 0) elog.info('enrichment pass complete', { ...summary });
  return summary;
}
