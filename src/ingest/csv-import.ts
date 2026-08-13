/**
 * CSV ingestion with named column profiles.
 *
 * `vedri-crm` matches Daniel's existing lead export (NAME, EMAIL, COMPANY,
 * WHERE DID WE MEET, SOURCE, STAGE, NOTE …). `built-list` is the generic schema
 * for purchased/built prospect lists. Both flow through the same normalise →
 * dedupe → upsert path and produce an ImportReport.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import type { LeadSource } from '../types.js';
import { recordEvent } from '../db/events.js';
import { upsertLead, getLeadByEmail } from '../db/leads.js';
import { normaliseRawLead } from './normalise.js';
import { dedupeByEmail } from './dedupe.js';
import { applySignal } from '../scoring.js';
import { emptyReport, type ImportReport, type LeadDraft, type RawLead } from './model.js';

type Record_ = Record<string, string>;
export interface CsvProfile {
  toRaw(rec: Record_, rowNum: number): RawLead;
  /** Optional clean-up of raw file text before parsing (e.g. LinkedIn preamble). */
  preprocess?(content: string): string;
  /**
   * Optional warm-start: points to seed from a lead's original stage, so a
   * mid-conversation reactivation lead carries on from where it was rather than
   * starting ice-cold. Return 0 for no warm start.
   */
  warmStartPoints?(rec: Record_): number;
}

/** Map an original CRM stage to warm-start points (reactivation). */
export function warmStartFromStage(stage: string | undefined): number {
  const s = (stage ?? '').toLowerCase();
  if (!s || s.includes('won') || s.includes('lost')) return 0;
  if (s.includes('negotiat')) return 52; // deep in — one signal from Hot
  if (s.includes('proposal')) return 45;
  if (s.includes('discovery')) return 40;
  if (s.includes('connection') || s.includes('connected') || s.includes('engaged')) return 30;
  if (s.includes('on hold') || s.includes('hold')) return 25;
  if (s.includes('initial') || s.includes('reach') || s.includes('contacted')) return 18;
  return 0;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse LinkedIn's "15 Jun 2024" connected-on date to ISO. */
export function parseLinkedInDate(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}T00:00:00.000Z`;
}

/** Case-insensitive column lookup across candidate header names. */
function col(rec: Record_, ...names: string[]): string | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) lower[k.trim().toLowerCase()] = v;
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v != null && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** Parse a UK DD-MM-YY(YY) date to ISO. Returns null for empty/placeholder/invalid. */
export function parseUkDate(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // 2026-01-01 is the placeholder used across the export — not a real engagement.
  if (iso === '2026-01-01') return null;
  return `${iso}T00:00:00.000Z`;
}

function mapVedriSource(raw: string | undefined): LeadSource {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('previous') || s.includes('past client')) return 'Past Client';
  if (s.includes('cold')) return 'Built List';
  if (s.includes('partner') || s.includes('partne')) return 'Referral'; // tolerate the "Partneship" typo in the export
  if (s.includes('network')) return 'Referral';
  if (s.includes('referr')) return 'Referral';
  if (s.includes('inbound') || s.includes('form')) return 'Inbound Form';
  return 'Other';
}

export const PROFILES: Record<string, CsvProfile> = {
  'vedri-crm': {
    toRaw(rec, _rowNum) {
      const where = col(rec, 'WHERE DID WE MEET');
      const stage = col(rec, 'STAGE');
      const note = col(rec, 'NOTE');
      const phone = col(rec, 'PHONE');
      const dates = ['INITIAL CONTACT', 'DISCOVERY CALL', 'FOLLOW UP']
        .map((k) => parseUkDate(col(rec, k)))
        .filter((d): d is string => Boolean(d))
        .sort();
      const lastContact = dates.length ? dates[dates.length - 1]!.slice(0, 10) : undefined;
      const notes = [
        where ? `Met: ${where}` : null,
        stage ? `Original stage: ${stage}` : null,
        lastContact ? `Last contact: ${lastContact}` : null,
        phone ? `Phone: ${phone}` : null,
        note ? note : null,
      ].filter(Boolean);
      // Historical contact dates live in notes as context — NOT in
      // lastEngagementAt, so the funnel's decay clock starts when we re-engage
      // (warm_start), not months in the past.
      return {
        email: col(rec, 'EMAIL'),
        fullName: col(rec, 'NAME'),
        company: col(rec, 'COMPANY'),
        phone,
        source: mapVedriSource(col(rec, 'SOURCE')),
        internalNotes: notes.length ? notes.join(' · ') : undefined,
        provenance: where,
        raw: rec,
      };
    },
    warmStartPoints(rec) {
      return warmStartFromStage(col(rec, 'STAGE'));
    },
  },

  // LinkedIn "Connections.csv" export. Note: LinkedIn withholds the email for
  // most connections, so many rows land in the rejected list (no email) — those
  // are manual-DM candidates, logged via `pnpm run log-touch`.
  linkedin: {
    preprocess(content) {
      // LinkedIn prepends a few "Notes:" lines before the real header row.
      const lines = content.split(/\r?\n/);
      const headerIdx = lines.findIndex((l) => /^"?First Name"?,/i.test(l));
      return headerIdx > 0 ? lines.slice(headerIdx).join('\n') : content;
    },
    toRaw(rec, _rowNum) {
      const position = col(rec, 'Position', 'Title');
      const url = col(rec, 'URL', 'Profile URL');
      const connectedOn = col(rec, 'Connected On');
      const notes = [
        position ? `Role: ${position}` : null,
        url ? `LinkedIn: ${url}` : null,
        connectedOn ? `Connected: ${connectedOn}` : null,
      ].filter(Boolean);
      return {
        email: col(rec, 'Email Address', 'email'),
        firstName: col(rec, 'First Name'),
        lastName: col(rec, 'Last Name'),
        company: col(rec, 'Company', 'Organization'),
        source: 'LinkedIn',
        internalNotes: notes.length ? notes.join(' · ') : undefined,
        lastEngagementAt: parseLinkedInDate(connectedOn) ?? undefined,
        provenance: 'LinkedIn connection export',
        raw: rec,
      };
    },
  },

  'built-list': {
    toRaw(rec, _rowNum) {
      const track = col(rec, 'track');
      const hook = col(rec, 'hook', 'why', 'why_now', 'why them why now');
      const sector = col(rec, 'sector', 'industry');
      const notes = [sector ? `Sector: ${sector}` : null, hook ? `Hook: ${hook}` : null].filter(Boolean);
      return {
        email: col(rec, 'email', 'e-mail'),
        firstName: col(rec, 'first_name', 'firstname', 'first name'),
        lastName: col(rec, 'last_name', 'lastname', 'last name'),
        fullName: col(rec, 'name', 'full name'),
        company: col(rec, 'company', 'organisation', 'organization'),
        companyDomain: col(rec, 'domain', 'website', 'company_domain'),
        source: 'Built List',
        track: track === 'Studio' || track === 'VFX' ? track : undefined,
        internalNotes: notes.length ? notes.join(' · ') : undefined,
        provenance: col(rec, 'list', 'list_name', 'source'),
        raw: rec,
      };
    },
  },
};

export function importCsv(path: string, profileName: keyof typeof PROFILES | string): ImportReport {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown CSV profile: ${profileName}. Known: ${Object.keys(PROFILES).join(', ')}`);

  const rawContent = readFileSync(path, 'utf8');
  const content = profile.preprocess ? profile.preprocess(rawContent) : rawContent;
  const records = parse(content, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as Record_[];

  const report = emptyReport(String(profileName), path);
  const drafts: LeadDraft[] = [];
  const warmPointsByEmail = new Map<string, number>();

  records.forEach((rec, i) => {
    const rowNum = i + 2; // header is row 1
    report.total++;
    const raw = profile.toRaw(rec, rowNum);
    const n = normaliseRawLead(raw);
    if (n.reject || !n.draft) {
      report.rejected.push({ row: rowNum, email: raw.email, reason: n.reject ?? 'unknown' });
      return;
    }
    for (const w of n.warnings) report.warnings.push({ row: rowNum, email: n.draft.email, reason: w });
    if (n.roleAccount) report.roleAccounts.push(n.draft.email);
    if (n.needsConsent) report.needsConsent.push(n.draft.email);
    if (profile.warmStartPoints) {
      const pts = profile.warmStartPoints(rec);
      if (pts > 0) warmPointsByEmail.set(n.draft.email, pts);
    }
    drafts.push(n.draft);
  });

  const { unique, duplicates } = dedupeByEmail(drafts);
  report.duplicatesInFile = duplicates;

  for (const draft of unique) {
    // Historical context notes are set once on creation. On re-import, preserve
    // whatever's there (HubSpot may own it) so import and reconcile don't churn.
    if (getLeadByEmail(draft.email)) delete draft.internalNotes;
    const lead = upsertLead(draft);
    report.imported++;
    report.bySource[lead.source] = (report.bySource[lead.source] ?? 0) + 1;
    recordEvent({
      leadId: lead.id,
      type: 'ingest.imported',
      trigger: `csv:${String(profileName)}`,
      reason: `Imported from ${basename(path)} (source ${lead.source})`,
      data: { needsConsent: draft.needsConsent ?? false },
    });
    // Warm-start (idempotent): seed points from the original stage and anchor
    // the decay clock to re-engagement (engagement:true) so it starts warm now.
    const warmPts = warmPointsByEmail.get(lead.email);
    if (warmPts) {
      applySignal(lead.id, 'warm_start', {
        trigger: 'reactivation-warm-start',
        points: warmPts,
        idempotencyKey: 'seed:warm_start',
        reason: `Warm start (+${warmPts}) from original stage`,
      });
    }
  }

  return report;
}
