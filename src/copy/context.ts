/**
 * Build the personalisation context for copy generation.
 *
 * CRITICAL: this is the boundary that keeps the internal kit list out of client
 * copy. We pass the generator only curated, client-safe facts — never the raw
 * internal notes (which for inbound leads contain derived kit requirements).
 */
import type { Lead } from '../types.js';
import { config } from '../../config/index.js';

export interface CopyContext {
  firstName: string;
  company: string | null;
  track: Lead['track'];
  recommendedApproach: Lead['recommendedApproach'];
  /** Safe reactivation context, e.g. "we last spoke ~March; you were mid-quote". */
  relationship: string | null;
  /** The ONLY facts the model may state. Client-safe positioning, no gear names. */
  approvedFacts: string[];
  /** Booking link for the call-to-action, if configured. */
  bookingLink: string | null;
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

  // Be explicit about relationship DEPTH so the generator can never mistake a
  // one-way reach-out for a conversation that actually happened.
  const s = (stage ?? '').toLowerCase();
  const parts: string[] = [];
  if (s.includes('initial') || s.includes('reach')) {
    parts.push(
      'we contacted them once but NO conversation took place — open as a re-introduction, do not imply we spoke',
    );
  } else if (s.includes('discovery') || s.includes('negotiat') || s.includes('proposal')) {
    parts.push(`a real conversation happened — it reached the "${stage}" stage`);
  } else if (stage) {
    parts.push(`the record shows stage "${stage}" — only claim contact, not a conversation, unless the stage implies one`);
  }
  if (last) parts.push(`last contact on record: ${last}`);
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
    bookingLink: config.booking.link || null,
  };
}
