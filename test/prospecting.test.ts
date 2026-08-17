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

  it('returns empty on junk', () => {
    expect(parseCandidates('no json here')).toEqual([]);
    expect(parseCandidates('{"an":"object, not an array"}')).toEqual([]);
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

  it('migration v2 created the prospects table with the status/domain indexes', () => {
    const version = db().pragma('user_version', { simple: true });
    expect(version).toBe(2);
    const cols = db().prepare("SELECT name FROM pragma_table_info('prospects')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('evidence_url');
  });
});
