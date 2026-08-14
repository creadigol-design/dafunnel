/**
 * Build the personalisation context for copy generation.
 *
 * CRITICAL: this is the boundary that keeps the internal kit list out of client
 * copy. We pass the generator only curated, client-safe facts — never the raw
 * internal notes (which for inbound leads contain derived kit requirements).
 */
import type { Lead } from '../types.js';

export interface CopyContext {
  firstName: string;
  company: string | null;
  track: Lead['track'];
  recommendedApproach: Lead['recommendedApproach'];
  /** Safe reactivation context, e.g. "we last spoke ~March; you were mid-quote". */
  relationship: string | null;
  /** The ONLY facts the model may state. Client-safe positioning, no gear names. */
  approvedFacts: string[];
}

/** Client-safe positioning points (no product/brand names — see the lint list). */
export const APPROVED_TALKING_POINTS: string[] = [
  'We do real-time compositing in-house — the final composited image is on the monitors as you shoot, not three weeks later in post.',
  'We support multi-camera shoots with no frustum limit, so every angle gets a live composited output.',
  'We hire in an LED volume when a job genuinely needs in-camera VP, rather than carrying the cost when it does not.',
  'We are in North Wales — close enough to Manchester, Liverpool, Birmingham and Cardiff to travel, without London-stage economics.',
];

function extractRelationship(lead: Lead): string | null {
  if (lead.source !== 'Past Client' && lead.source !== 'Referral' && lead.source !== 'Other') {
    return null;
  }
  const notes = lead.internalNotes ?? '';
  const stage = notes.match(/Original stage:\s*([^·]+)/i)?.[1]?.trim();
  const last = notes.match(/Last contact:\s*([0-9-]+)/i)?.[1]?.trim();
  const parts: string[] = [];
  if (last) parts.push(`we last spoke around ${last}`);
  if (stage) parts.push(`the conversation was at the "${stage}" stage`);
  return parts.length ? parts.join('; ') : null;
}

export function buildContext(lead: Lead): CopyContext {
  return {
    firstName: lead.firstName ?? 'there',
    company: lead.company,
    track: lead.track,
    recommendedApproach: lead.recommendedApproach,
    relationship: extractRelationship(lead),
    approvedFacts: APPROVED_TALKING_POINTS,
  };
}
