/**
 * Prospector tests — the honesty gate (no evidence URL → dropped), domain
 * normalisation + dedupe against everything the funnel already knows, the
 * weekly schedule gate, and the migration that adds the prospects table.
 *
 * No live API: parseCandidates is pure, and runProspector is never called here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vedri-prospect-'));
process.env.DB_PATH = join(tmp, 'prospect.db');
process.env.LOG_DIR = join(tmp, 'logs');
process.env.HUBSPOT_PRIVATE_APP_TOKEN = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.MAIL_PASS = '';
process.env.SEQUENCES_ACTIVE = 'none';

const { db, closeDb } = await import('../src/db/index.js');
const { upsertLead } = await import('../src/db/leads.js');
const { normaliseDomain, parseCandidates, prospectorDue, knownDomains } = await import(
  '../src/prospecting/discover.js'
);
const { parseContact, parseIgResearch } = await import('../src/prospecting/enrich.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('normaliseDomain', () => {
  it('strips protocol, www, path and port', () => {
    expect(normaliseDomain('https://www.prodco.co.uk/work?x=1')).toBe('prodco.co.uk');
    expect(normaliseDomain('http://prodco.ie:8080/about')).toBe('prodco.ie');
    expect(normaliseDomain('WWW.Agency.Wales')).toBe('agency.wales');
  });
  it('rejects non-domains', () => {
    expect(normaliseDomain('')).toBeNull();
    expect(normaliseDomain(null)).toBeNull();
    expect(normaliseDomain('not a domain')).toBeNull();
  });
});

describe('parseCandidates — the honesty gate', () => {
  const good = {
    company: 'Alpha Films',
    website: 'https://alphafilms.co.uk',
    location: 'Manchester',
    category: 'prodco',
    track: 'Studio',
    whyFit: 'Branded content prodco with a 2026 slate of studio interview shoots.',
    evidenceUrl: 'https://alphafilms.co.uk/work',
    contactName: null,
    contactEmail: null,
    contactPageUrl: null,
  };

  it('accepts a well-formed candidate and derives the domain', () => {
    const out = parseCandidates(JSON.stringify([good]));
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('alphafilms.co.uk');
    expect(out[0]!.track).toBe('Studio');
  });

  it('drops candidates without a verifiable evidence URL', () => {
    const out = parseCandidates(
      JSON.stringify([
        { ...good, evidenceUrl: '' },
        { ...good, company: 'Beta', evidenceUrl: 'their website' },
        { ...good, company: 'Gamma', evidenceUrl: 'https://gamma.ie/projects' },
      ]),
    );
    expect(out.map((c) => c.company)).toEqual(['Gamma']);
  });

  it('drops invented contact emails that do not parse, keeps the candidate', () => {
    const out = parseCandidates(JSON.stringify([{ ...good, contactEmail: 'not-an-email' }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.contactEmail).toBeNull();
  });

  it('tolerates code fences and preamble, defaults unknown track to Both', () => {
    const text = 'Here are the results:\n```json\n' + JSON.stringify([{ ...good, track: 'Everything' }]) + '\n```';
    const out = parseCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.track).toBe('Both');
  });

  it('finds the array even when prose carries citation markers like [1]', () => {
    const text =
      'Based on my searches [1][2], strong fits near Manchester [3]:\n' +
      JSON.stringify([good]) +
      '\nSources: [1] example.com [2] example.org';
    const out = parseCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.company).toBe('Alpha Films');
  });

  it('returns empty on junk', () => {
    expect(parseCandidates('no json here')).toEqual([]);
    expect(parseCandidates('{"an":"object, not an array"}')).toEqual([]);
  });
});

describe('parseContact — enrichment honesty gate', () => {
  it('keeps a published contact with its source page', () => {
    const c = parseContact(
      JSON.stringify({
        contactName: 'Sam Jones',
        contactRole: 'Executive Producer',
        contactEmail: 'sam@alphafilms.co.uk',
        contactPageUrl: 'https://alphafilms.co.uk/contact',
        sourceUrl: 'https://alphafilms.co.uk/team',
      }),
    );
    expect(c.contactEmail).toBe('sam@alphafilms.co.uk');
    expect(c.contactRole).toBe('Executive Producer');
  });

  it('drops an email with no published source — that is a guess', () => {
    const c = parseContact(
      JSON.stringify({ contactName: 'Sam Jones', contactEmail: 'sam@alphafilms.co.uk', sourceUrl: null }),
    );
    expect(c.contactEmail).toBeNull();
    expect(c.contactName).toBe('Sam Jones');
  });

  it('drops malformed emails and "null" strings; survives junk', () => {
    const c = parseContact(
      JSON.stringify({ contactName: 'null', contactEmail: 'not-an-email', sourceUrl: 'https://x.co/team' }),
    );
    expect(c.contactName).toBeNull();
    expect(c.contactEmail).toBeNull();
    expect(parseContact('total junk').contactEmail).toBeNull();
  });
});

describe('parseIgResearch — Instagram account research', () => {
  it('fills in who the account is, honesty rules intact', () => {
    const r = parseIgResearch(
      JSON.stringify({
        company: 'Beta Studios',
        website: 'https://betastudios.ie',
        location: 'Dublin',
        category: 'prodco',
        whyFit: 'Makes branded docs for Irish tech firms.',
        contactName: 'Ana Silva',
        contactRole: 'Founder',
        contactEmail: 'ana@betastudios.ie',
        contactPageUrl: null,
        sourceUrl: 'https://betastudios.ie/about',
      }),
    );
    expect(r.company).toBe('Beta Studios');
    expect(r.contactEmail).toBe('ana@betastudios.ie');
  });

  it('an email without a source page is still dropped', () => {
    const r = parseIgResearch(JSON.stringify({ company: 'Beta', contactEmail: 'x@beta.ie', sourceUrl: null }));
    expect(r.contactEmail).toBeNull();
    expect(r.company).toBe('Beta');
  });
});

describe('prospectorDue — weekly gate', () => {
  const now = new Date('2026-08-17T09:00:00.000Z');
  it('due when never run, or a week has passed; force always wins', () => {
    expect(prospectorDue(now, null)).toBe(true);
    expect(prospectorDue(now, '2026-08-01T09:00:00.000Z')).toBe(true);
    expect(prospectorDue(now, '2026-08-16T09:00:00.000Z')).toBe(false);
    expect(prospectorDue(now, '2026-08-16T09:00:00.000Z', true)).toBe(true);
  });
});

describe('knownDomains — dedupe set', () => {
  it('collects lead email + company domains (not freemail), prospect domains and suppression domains', () => {
    upsertLead({ email: 'jo@knownprodco.co.uk', companyDomain: 'knownprodco.co.uk' });
    upsertLead({ email: 'sam@gmail.com' }); // freemail — must NOT block gmail.com
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO prospects (id, company, domain, evidence_url, status, discovered_at, created_at, updated_at)
         VALUES ('p1', 'Binned Co', 'binnedco.ie', 'https://binnedco.ie', 'discarded', ?, ?, ?)`,
      )
      .run(now, now, now);
    db()
      .prepare("INSERT INTO suppression (email, reason, created_at) VALUES ('no@nomore.co.uk', 'hard no', ?)")
      .run(now);

    const known = knownDomains();
    expect(known.has('knownprodco.co.uk')).toBe(true);
    expect(known.has('binnedco.ie')).toBe(true); // discarded stays binned
    expect(known.has('nomore.co.uk')).toBe(true);
    expect(known.has('gmail.com')).toBe(false);
  });

  it('migrations created the prospects table incl. the enrichment columns', () => {
    const version = db().pragma('user_version', { simple: true });
    expect(version).toBe(4);
    const cols = (db().prepare("SELECT name FROM pragma_table_info('prospects')").all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of ['evidence_url', 'contact_role', 'contact_source_url', 'enriched_at', 'origin']) {
      expect(cols).toContain(c);
    }
  });
});
