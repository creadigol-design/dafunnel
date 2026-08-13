/**
 * Ingestion tests: normalisation/validation, dedupe, the FormSubmit parser
 * (against the real email format), and reactivation classification.
 */
import { describe, it, expect } from 'vitest';
import {
  normaliseRawLead,
  isRoleAccount,
  isFreemail,
  extractDomain,
  splitName,
} from '../src/ingest/normalise.js';
import { dedupeByEmail } from '../src/ingest/dedupe.js';
import { parseFormSubmit, submissionToRawLead } from '../src/ingest/inbound.js';
import { parseUkDate, parseLinkedInDate, PROFILES } from '../src/ingest/csv-import.js';
import { classifyReactivation } from '../src/ingest/reactivation.js';
import { makeLead } from './fixtures.js';

describe('normalise helpers', () => {
  it('detects role inboxes', () => {
    expect(isRoleAccount('info@prodco.co.uk')).toBe(true);
    expect(isRoleAccount('hello@studio.tv')).toBe(true);
    expect(isRoleAccount('jo@prodco.co.uk')).toBe(false);
  });
  it('detects freemail', () => {
    expect(isFreemail('jo@gmail.com')).toBe(true);
    expect(isFreemail('jo@prodco.co.uk')).toBe(false);
  });
  it('extracts domains and splits names', () => {
    expect(extractDomain('Jo@ProdCo.co.uk')).toBe('prodco.co.uk');
    expect(splitName('Jo Rhys Davies')).toEqual({ firstName: 'Jo', lastName: 'Rhys Davies' });
  });
});

describe('normaliseRawLead', () => {
  it('rejects missing/invalid email', () => {
    expect(normaliseRawLead({ source: 'Built List' }).reject).toBe('missing email');
    expect(normaliseRawLead({ email: 'not-an-email', source: 'Built List' }).reject).toContain('invalid');
  });
  it('flags freemail as needing consent and asserts no LIA basis', () => {
    const n = normaliseRawLead({ email: 'jo@gmail.com', source: 'Built List' });
    expect(n.needsConsent).toBe(true);
    expect(n.draft?.liaBasis).toBeNull();
  });
  it('sets a legitimate-interest basis for B2B corporate addresses', () => {
    const n = normaliseRawLead({ email: 'jo@prodco.co.uk', company: 'ProdCo', source: 'Built List' });
    expect(n.needsConsent).toBe(false);
    expect(n.draft?.liaBasis).toContain('Legitimate interest');
    expect(n.draft?.companyDomain).toBe('prodco.co.uk');
  });
  it('warns on missing company', () => {
    const n = normaliseRawLead({ email: 'jo@prodco.co.uk', source: 'Built List' });
    expect(n.warnings).toContain('missing company');
  });
});

describe('dedupeByEmail', () => {
  it('collapses duplicate emails, keeping the first', () => {
    const { unique, duplicates } = dedupeByEmail([
      { email: 'a@x.com', firstName: 'A1' },
      { email: 'A@x.com', firstName: 'A2' },
      { email: 'b@x.com' },
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(1);
    expect(unique[0]!.firstName).toBe('A1');
  });
});

describe('FormSubmit parser (real format)', () => {
  const body = `Someone just submitted your form on https://vfx.vedri.studio/.

Here's what they had to say:
*name: *

Daniel Evans

------------------------------
*email: *

jo@prodco.co.uk

------------------------------
*company: *

ProdCo

------------------------------
*service: *

VFX cleanups & compositing

------------------------------
*message: *

Need 40 shots cleaned up

------------------------------

Submitted at Sat, Jul 25, 2026 3:01 PM (UTC)`;

  it('extracts the source URL and fields', () => {
    const p = parseFormSubmit(body);
    expect(p.sourceUrl).toBe('https://vfx.vedri.studio/');
    expect(p.fields.email).toBe('jo@prodco.co.uk');
    expect(p.fields.company).toBe('ProdCo');
    expect(p.fields.message).toBe('Need 40 shots cleaned up');
  });

  it('maps a VFX submission to the VFX track with the brief in internal notes', () => {
    const raw = submissionToRawLead(parseFormSubmit(body));
    expect(raw.track).toBe('VFX');
    expect(raw.source).toBe('Inbound Form');
    expect(raw.internalNotes).toContain('Need 40 shots');
    // Core identity fields are not duplicated into internal notes:
    expect(raw.internalNotes).not.toContain('jo@prodco.co.uk');
  });

  it('maps a decision-matrix recommendation to an approach', () => {
    const dm = `submitted your form on https://vedri.studio/decision-matrix
*name: *

Sam Lee
------------------------------
*email: *

sam@bigbrand.com
------------------------------
*recommendation: *

Green Screen with Real-Time Compositing
------------------------------`;
    const raw = submissionToRawLead(parseFormSubmit(dm));
    expect(raw.source).toBe('Decision Matrix');
    expect(raw.recommendedApproach).toBe('Green Screen');
    expect(raw.track).toBe('Studio');
  });
});

describe('parseUkDate', () => {
  it('parses DD-MM-YY to ISO and rejects the placeholder', () => {
    expect(parseUkDate('23-02-26')).toBe('2026-02-23T00:00:00.000Z');
    expect(parseUkDate('01-01-26')).toBeNull(); // placeholder
    expect(parseUkDate('')).toBeNull();
    expect(parseUkDate('garbage')).toBeNull();
  });
});

describe('LinkedIn profile', () => {
  it('parses LinkedIn connected-on dates', () => {
    expect(parseLinkedInDate('15 Jun 2024')).toBe('2024-06-15T00:00:00.000Z');
    expect(parseLinkedInDate('2 Mar 2025')).toBe('2025-03-02T00:00:00.000Z');
    expect(parseLinkedInDate('')).toBeNull();
  });

  it('strips the notes preamble before the header row', () => {
    const raw = `Notes:\n"blah blah privacy note"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nAlys,Morgan,url,alys@x.co.uk,Northlight,Producer,15 Jun 2024`;
    const cleaned = PROFILES.linkedin!.preprocess!(raw);
    expect(cleaned.startsWith('First Name,')).toBe(true);
  });

  it('maps a connection row to a LinkedIn-source RawLead with role in notes', () => {
    const raw = PROFILES.linkedin!.toRaw(
      {
        'First Name': 'Alys',
        'Last Name': 'Morgan',
        'Email Address': 'alys@northlightfilms.co.uk',
        Company: 'Northlight Films',
        Position: 'Producer',
        'Connected On': '15 Jun 2024',
        URL: 'https://linkedin.com/in/alysmorgan',
      },
      2,
    );
    expect(raw.source).toBe('LinkedIn');
    expect(raw.company).toBe('Northlight Films');
    expect(raw.internalNotes).toContain('Role: Producer');
    expect(raw.lastEngagementAt).toBe('2024-06-15T00:00:00.000Z');
  });
});

describe('reactivation classification', () => {
  it('routes past clients to worked-with-us', () => {
    expect(classifyReactivation(makeLead({ source: 'Past Client' }))).toBe('worked-with-us');
  });
  it('routes quote/negotiation notes to quoted-but-lost', () => {
    expect(
      classifyReactivation(makeLead({ source: 'Referral', internalNotes: 'Original stage: Negotiating' })),
    ).toBe('quoted-but-lost');
  });
  it('defaults to enquired-never-quoted', () => {
    expect(classifyReactivation(makeLead({ source: 'Referral', internalNotes: 'Met: BSC' }))).toBe(
      'enquired-never-quoted',
    );
  });
});
