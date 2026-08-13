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
import { upsertLead } from '../db/leads.js';
import { normaliseRawLead } from './normalise.js';
import { dedupeByEmail } from './dedupe.js';
import { emptyReport, type ImportReport, type LeadDraft, type RawLead } from './model.js';

type Record_ = Record<string, string>;
export interface CsvProfile {
  toRaw(rec: Record_, rowNum: number): RawLead;
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
      const notes = [
        where ? `Met: ${where}` : null,
        stage ? `Original stage: ${stage}` : null,
        phone ? `Phone: ${phone}` : null,
        note ? note : null,
      ].filter(Boolean);
      const dates = ['INITIAL CONTACT', 'DISCOVERY CALL', 'FOLLOW UP']
        .map((k) => parseUkDate(col(rec, k)))
        .filter((d): d is string => Boolean(d))
        .sort();
      return {
        email: col(rec, 'EMAIL'),
        fullName: col(rec, 'NAME'),
        company: col(rec, 'COMPANY'),
        phone,
        source: mapVedriSource(col(rec, 'SOURCE')),
        internalNotes: notes.length ? notes.join(' · ') : undefined,
        lastEngagementAt: dates.length ? dates[dates.length - 1]! : undefined,
        provenance: where,
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

  const content = readFileSync(path, 'utf8');
  const records = parse(content, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as Record_[];

  const report = emptyReport(String(profileName), path);
  const drafts: LeadDraft[] = [];

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
    drafts.push(n.draft);
  });

  const { unique, duplicates } = dedupeByEmail(drafts);
  report.duplicatesInFile = duplicates;

  for (const draft of unique) {
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
  }

  return report;
}
