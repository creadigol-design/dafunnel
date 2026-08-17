/**
 * Prospector — finds NEW companies that match the ICP, using Claude with live
 * web search, and queues them as candidates for Daniel to approve or discard
 * in the viewer. Candidates are NOT leads: nothing is contacted, scored or
 * synced until a human approves one.
 *
 * Honesty rules mirror the copy engine: every candidate must carry a source
 * URL that backs its "why it fits" claim; candidates without one are dropped.
 * Dedupe is by domain against existing leads, existing prospects (including
 * discarded ones — a binned company stays binned) and the suppression list.
 *
 * Runs weekly (gated by sync_state, like the governor) inside the cycle, or on
 * demand via `pnpm run prospect`.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db, getSyncState, setSyncState } from '../db/index.js';
import { recordEvent } from '../db/events.js';
import { queueAlert } from '../alerts/queue.js';
import { completeWithWebSearch } from '../anthropic.js';
import { FREEMAIL_DOMAINS, extractDomain } from '../ingest/normalise.js';

const plog = log.child('prospector');

const LAST_RUN_KEY = 'prospector.last_run_at';
/** Weekly cadence, with slack so the hourly cycle catches it same-day. */
const MIN_GAP_MS = 6.5 * 86_400_000;
/** Candidates requested per run — enough to review in one sitting, no more. */
const CANDIDATES_PER_RUN = 12;

export interface ProspectCandidate {
  company: string;
  website: string | null;
  domain: string | null;
  location: string | null;
  category: string | null;
  track: 'Studio' | 'VFX' | 'Both';
  whyFit: string;
  evidenceUrl: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPageUrl: string | null;
}

/** Normalise a URL or bare domain to a comparable registrable-host form. */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // protocol
  s = s.split(/[/?#]/)[0] ?? s; // path
  s = s.replace(/^www\./, '');
  s = s.split('@').pop() ?? s; // tolerate emails/userinfo
  s = s.split(':')[0] ?? s; // port
  return s.includes('.') ? s : null;
}

/**
 * Every domain the funnel already knows about — existing leads (by company
 * domain and by email domain, freemail excluded), all prospects regardless of
 * status, and the suppression list. The prospector must never re-suggest any
 * of these.
 */
export function knownDomains(): Set<string> {
  const known = new Set<string>();
  const conn = db();
  const leadRows = conn.prepare('SELECT email, company_domain FROM leads').all() as {
    email: string;
    company_domain: string | null;
  }[];
  for (const r of leadRows) {
    const cd = normaliseDomain(r.company_domain);
    if (cd) known.add(cd);
    const ed = extractDomain(r.email);
    if (ed && !FREEMAIL_DOMAINS.has(ed)) known.add(ed);
  }
  const prospectRows = conn.prepare('SELECT domain FROM prospects').all() as { domain: string | null }[];
  for (const r of prospectRows) {
    const d = normaliseDomain(r.domain);
    if (d) known.add(d);
  }
  const suppressed = conn.prepare('SELECT email FROM suppression').all() as { email: string }[];
  for (const r of suppressed) {
    const d = extractDomain(r.email);
    if (d && !FREEMAIL_DOMAINS.has(d)) known.add(d);
  }
  return known;
}

const SYSTEM = `You are a new-business researcher for vedrí, an independent virtual production and VFX studio in North Wales. You find companies that might hire them, using web search, and you are rigorous about evidence.

Hard rules:
- Only include companies you actually found in your searches. NEVER invent a company, URL, person or email address.
- Every candidate MUST include "evidenceUrl": a real page from your search results that backs the "whyFit" claim (their site, a recent project page, a directory profile, a news piece). A candidate without a working evidence URL is worthless — omit it instead.
- Only include a contact name or email if it is published on the pages you found. Otherwise use null. Guessed emails poison a sender's reputation.
- Prefer companies with visibly active, recent work (2025–2026).
- Return ONLY a JSON array, no preamble.`;

function userPrompt(avoid: string[]): string {
  return `Find up to ${CANDIDATES_PER_RUN} NEW prospective clients for vedrí. Two service tracks:

- "Studio": real-time green-screen compositing shoots (the final composited image on the monitors as they shoot). Best fits: production companies, video/creative agencies, brand content studios and corporate video producers who shoot interviews, branded content, music videos or short drama — within reach of North Wales: Manchester, Liverpool, Chester, Leeds, Birmingham, Cardiff, and Dublin/Ireland.
- "VFX": post-production compositing, cleanup and green-screen finishing. Location matters less — anywhere in the UK or Ireland with an active slate.

Ideal candidates commission projects in the £7,000–£20,000 range: independent and small-to-mid outfits, not global networks, broadcasters' in-house teams, or companies that are themselves virtual production / VFX studios (those are competitors, not clients).

Do NOT include any company whose domain is in this list (already known to us):
${avoid.join(', ') || '(none yet)'}

For each candidate return:
{"company": "...", "website": "https://...", "location": "town/city", "category": "prodco|agency|post house|brand studio|other", "track": "Studio|VFX|Both", "whyFit": "one sentence, max 30 words, grounded in what you actually found", "evidenceUrl": "https://... (the page that backs whyFit)", "contactName": null, "contactEmail": null, "contactPageUrl": "https://... or null"}

Return the JSON array only.`;
}

/**
 * Find the JSON array in a model response. Web-search responses interleave
 * prose and citation markers like [1], so "first [ to last ]" is not enough —
 * try every candidate span that starts at a plausible array-of-objects opener.
 */
function extractArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1]! : text;
  const starts: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '[' && /^\[\s*\{/.test(source.slice(i, i + 8))) starts.push(i);
  }
  if (source.trimStart().startsWith('[')) starts.unshift(source.indexOf('['));
  for (const start of starts) {
    for (let end = source.lastIndexOf(']'); end > start; end = source.lastIndexOf(']', end - 1)) {
      try {
        const parsed: unknown = JSON.parse(source.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // keep walking earlier closing brackets
      }
    }
  }
  return null;
}

/** Parse + validate the model's output. Exported for tests. */
export function parseCandidates(text: string): ProspectCandidate[] {
  const parsed = extractArray(text);
  if (!parsed) return [];

  const out: ProspectCandidate[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const company = typeof raw.company === 'string' ? raw.company.trim() : '';
    const evidenceUrl = typeof raw.evidenceUrl === 'string' ? raw.evidenceUrl.trim() : '';
    // No company or no verifiable evidence → drop. The evidence rule is the
    // whole point: an unverified candidate is an invented one.
    if (!company || !/^https?:\/\/\S+\.\S+/.test(evidenceUrl)) continue;
    const website = typeof raw.website === 'string' && /^https?:\/\//.test(raw.website) ? raw.website.trim() : null;
    const track = raw.track === 'Studio' || raw.track === 'VFX' || raw.track === 'Both' ? raw.track : 'Both';
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const contactEmail = str(raw.contactEmail);
    out.push({
      company,
      website,
      domain: normaliseDomain(website ?? (contactEmail ? extractDomain(contactEmail) : null)),
      location: str(raw.location),
      category: str(raw.category),
      track,
      whyFit: str(raw.whyFit) ?? '',
      evidenceUrl,
      contactName: str(raw.contactName),
      contactEmail: contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ? contactEmail : null,
      contactPageUrl: str(raw.contactPageUrl),
    });
  }
  return out;
}

/** Weekly gate, same pattern as the governor. Exported for tests. */
export function prospectorDue(asOf: Date, lastRunIso: string | null, force = false): boolean {
  if (force) return true;
  if (!lastRunIso) return true;
  return asOf.getTime() - Date.parse(lastRunIso) >= MIN_GAP_MS;
}

export interface ProspectorSummary {
  ran: boolean;
  found: number;
  queued: number;
  duplicates: number;
  dropped: number;
  skippedReason?: string;
}

export async function runProspector(asOf: Date = new Date(), force = false): Promise<ProspectorSummary> {
  const none: ProspectorSummary = { ran: false, found: 0, queued: 0, duplicates: 0, dropped: 0 };
  if (!prospectorDue(asOf, getSyncState(LAST_RUN_KEY), force)) return none;
  if (!config.anthropic.apiKey) {
    return { ...none, skippedReason: 'ANTHROPIC_API_KEY not set' };
  }

  const known = knownDomains();
  // The avoid-list in the prompt is capped; the post-filter below is the real
  // gate, so a truncated list only costs the model a wasted suggestion.
  const avoid = [...known].sort().slice(0, 250);

  plog.info('prospecting run starting', { knownDomains: known.size });
  const text = await completeWithWebSearch({
    system: SYSTEM,
    user: userPrompt(avoid),
    // Budget balance learned live: 15 searches under 8192 tokens ran out of
    // room before the final array. Fewer searches, much more headroom.
    maxSearches: 10,
    maxTokens: 16384,
  });

  const candidates = parseCandidates(text);
  if (candidates.length === 0) {
    // Keep the evidence in the log — "found 0" with no trace is undebuggable.
    plog.warn('no candidates parsed from the response', { chars: text.length, preview: text.slice(0, 400) });
  }
  const summary: ProspectorSummary = { ran: true, found: candidates.length, queued: 0, duplicates: 0, dropped: 0 };

  const conn = db();
  const now = asOf.toISOString();
  for (const c of candidates) {
    if (c.domain && known.has(c.domain)) {
      summary.duplicates++;
      continue;
    }
    if (!c.whyFit) {
      summary.dropped++;
      continue;
    }
    const id = randomUUID();
    conn
      .prepare(
        `INSERT INTO prospects (id, company, website, domain, location, category, track, why_fit,
           evidence_url, contact_name, contact_email, contact_page_url, status, discovered_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
      )
      .run(
        id, c.company, c.website, c.domain, c.location, c.category, c.track, c.whyFit,
        c.evidenceUrl, c.contactName, c.contactEmail, c.contactPageUrl, now, now, now,
      );
    if (c.domain) known.add(c.domain); // dedupe within the batch too
    recordEvent({
      type: 'prospect.discovered',
      trigger: force ? 'forced' : 'schedule',
      reason: `Prospector found ${c.company}${c.location ? ` (${c.location})` : ''}: ${c.whyFit}`,
      data: { prospectId: id, company: c.company, domain: c.domain, track: c.track, evidenceUrl: c.evidenceUrl },
    });
    summary.queued++;
  }

  setSyncState(LAST_RUN_KEY, now);
  if (summary.queued > 0) {
    queueAlert('prospects_found', {
      payload: {
        queued: summary.queued,
        note: `New prospect candidates await your review in the portal under /prospects.`,
      },
    });
  }
  plog.info('prospecting run complete', { ...summary });
  return summary;
}
