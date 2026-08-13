/**
 * Inbound adapter — decision-matrix + contact-form submissions arriving at
 * info@vedri.studio via FormSubmit.co.
 *
 * These are the highest-value leads in the system. The parser is modelled on the
 * real FormSubmit email format (verified against a live submission): `*field: *`
 * blocks separated by dashed rules, with the form URL in the preamble.
 *
 * The client's own quiz answers go into internal notes; the derived kit list is
 * added later and is NEVER client-facing (enforced by the copy lint in Phase 5).
 *
 * Live Gmail polling is gated on Google OAuth (Phase 5/6). The pure parser +
 * `ingestInboundBodies` are testable now and are what the poller will feed.
 */
import type { RecommendedApproach, Track } from '../types.js';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { upsertLead } from '../db/leads.js';
import { normaliseRawLead } from './normalise.js';
import { emptyReport, type ImportReport, type RawLead } from './model.js';

const ilog = log.child('inbound');

export interface ParsedSubmission {
  sourceUrl?: string;
  fields: Record<string, string>;
}

/** Parse a FormSubmit.co notification email body into its fields. */
export function parseFormSubmit(body: string): ParsedSubmission {
  const urlM = body.match(/submitted your form on\s+(\S+)/i);
  const sourceUrl = urlM?.[1]?.replace(/[.,]+$/, '');
  const fields: Record<string, string> = {};
  for (const chunk of body.split(/-{5,}/)) {
    const m = chunk.match(/\*\s*([^:*]+?)\s*:\s*\*\s*([\s\S]*)/);
    if (m) {
      const key = m[1]!.trim().toLowerCase();
      const val = m[2]!.trim();
      if (key && val) fields[key] = val;
    }
  }
  return { sourceUrl, fields };
}

function mapApproach(text: string | undefined): RecommendedApproach | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('green screen') || t.includes('greenscreen')) return 'Green Screen';
  if (t.includes('3d') || t.includes('unreal')) return '3D Unreal LED';
  if (t.includes('2d') || t.includes('plate')) return '2D Plates LED';
  if (t.includes('hybrid')) return 'Hybrid';
  return null;
}

const CORE_FIELDS = new Set(['name', 'email', 'company', 'first name', 'last name']);

/** Turn a parsed submission into a RawLead. */
export function submissionToRawLead(parsed: ParsedSubmission): RawLead {
  const f = parsed.fields;
  const isVfx =
    (parsed.sourceUrl ?? '').toLowerCase().includes('vfx') ||
    (f.service ?? '').toLowerCase().includes('vfx');
  const track: Track = isVfx ? 'VFX' : 'Studio';

  const recommendation = f.recommendation ?? f['recommended approach'] ?? f.approach;
  const isDecisionMatrix = Boolean(recommendation) || (parsed.sourceUrl ?? '').includes('matrix');

  // Everything the client told us that isn't a core identity field is internal
  // context (quiz answers, tracking level, brief). Kept internal by policy.
  const internal = Object.entries(f)
    .filter(([k]) => !CORE_FIELDS.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');

  return {
    email: f.email,
    fullName: f.name,
    firstName: f['first name'],
    lastName: f['last name'],
    company: f.company,
    source: isDecisionMatrix ? 'Decision Matrix' : 'Inbound Form',
    track,
    recommendedApproach: mapApproach(recommendation) ?? undefined,
    internalNotes: internal || undefined,
    provenance: parsed.sourceUrl,
  };
}

/** Ingest a batch of raw email bodies (what the Gmail poller feeds). */
export function ingestInboundBodies(
  bodies: { body: string; receivedAt?: string }[],
): ImportReport {
  const report = emptyReport('inbound');
  for (const { body, receivedAt } of bodies) {
    report.total++;
    const parsed = parseFormSubmit(body);
    const raw = submissionToRawLead(parsed);
    if (receivedAt) raw.lastEngagementAt = receivedAt;
    const n = normaliseRawLead(raw);
    if (n.reject || !n.draft) {
      report.rejected.push({ reason: n.reject ?? 'unknown parse', row: report.total });
      continue;
    }
    if (n.roleAccount) report.roleAccounts.push(n.draft.email);
    const lead = upsertLead({ ...n.draft, lastEngagementAt: raw.lastEngagementAt ?? n.draft.lastEngagementAt });
    report.imported++;
    report.bySource[lead.source] = (report.bySource[lead.source] ?? 0) + 1;
    recordEvent({
      leadId: lead.id,
      type: 'ingest.inbound',
      trigger: 'inbound-form',
      reason: `Inbound ${lead.source} submission (${lead.track})`,
      data: { recommendedApproach: lead.recommendedApproach, sourceUrl: parsed.sourceUrl ?? null },
    });
    ilog.info('inbound lead ingested', { email: lead.email, source: lead.source, track: lead.track });
  }
  return report;
}

/** Live poll of info@vedri.studio — gated on Google OAuth (Phase 5/6). */
export async function pollInbound(): Promise<ImportReport | null> {
  if (!config.google.refreshToken) {
    ilog.warn('Gmail not authorised — inbound polling skipped (Phase 5/6 setup)');
    return null;
  }
  // Phase 5/6: fetch unread FormSubmit messages via Gmail API, pass bodies to
  // ingestInboundBodies, label them processed. Wired when OAuth lands.
  ilog.info('inbound polling ready but not yet wired to Gmail API');
  return null;
}
