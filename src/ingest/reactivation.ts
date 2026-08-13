/**
 * Reactivation — past clients and dead quotes. These convert ~6× better than
 * cold and cost nothing, so this list is worked FIRST, before any cold email.
 *
 * Import is just a CSV import with the `vedri-crm` profile (Daniel's export IS
 * the reactivation/relationship list). Segmentation is a classification over the
 * imported leads so the sequence engine can lead with the right message.
 */
import type { Lead } from '../types.js';
import { allLeads } from '../db/leads.js';

export type ReactivationSegment =
  | 'worked-with-us'
  | 'quoted-but-lost'
  | 'enquired-never-quoted';

const QUOTE_HINTS = ['quote', 'proposal', 'negotiat', 'on hold', 'lost', 'estimate'];

/** Classify a lead into a reactivation segment from its source + notes. */
export function classifyReactivation(lead: Lead): ReactivationSegment {
  const notes = (lead.internalNotes ?? '').toLowerCase();
  if (lead.source === 'Past Client' || notes.includes('previous client') || notes.includes('worked with')) {
    return 'worked-with-us';
  }
  if (QUOTE_HINTS.some((h) => notes.includes(h))) return 'quoted-but-lost';
  return 'enquired-never-quoted';
}

export interface ReactivationView {
  segments: Record<ReactivationSegment, Lead[]>;
  counts: Record<ReactivationSegment, number>;
}

/**
 * Build the reactivation view over all known leads that aren't cold built-list
 * or suppressed. Order of work: worked-with-us → quoted-but-lost → enquired.
 */
export function buildReactivationView(): ReactivationView {
  const segments: Record<ReactivationSegment, Lead[]> = {
    'worked-with-us': [],
    'quoted-but-lost': [],
    'enquired-never-quoted': [],
  };
  for (const lead of allLeads()) {
    if (lead.suppressed) continue;
    if (lead.source === 'Built List') continue; // cold, not reactivation
    segments[classifyReactivation(lead)].push(lead);
  }
  return {
    segments,
    counts: {
      'worked-with-us': segments['worked-with-us'].length,
      'quoted-but-lost': segments['quoted-but-lost'].length,
      'enquired-never-quoted': segments['enquired-never-quoted'].length,
    },
  };
}
