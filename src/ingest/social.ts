/**
 * LinkedIn / social adapter — manual touch logging, no automation or scraping
 * (that gets accounts restricted and the ROI isn't worth it).
 *
 * Daniel logs a DM or connection via `pnpm run log-touch`; the system tracks it,
 * scores it (Phase 4), and reminds him when a follow-up is due (Phase 5). A
 * watched CSV folder is handled by the generic importer with the built-list
 * profile.
 */
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { upsertLead, getLeadByEmail } from '../db/leads.js';
import { normaliseRawLead } from './normalise.js';
import type { Track } from '../types.js';

const slog = log.child('social');

export interface TouchInput {
  email: string;
  name?: string;
  company?: string;
  track?: Track;
  note: string;
  /** Days until the follow-up reminder is due (default 4). */
  followUpDays?: number;
}

/** Log a LinkedIn/social touch, upserting the lead and scheduling a follow-up. */
export function logTouch(input: TouchInput): { ok: boolean; message: string } {
  const n = normaliseRawLead({
    email: input.email,
    fullName: input.name,
    company: input.company,
    track: input.track,
    source: 'LinkedIn',
    internalNotes: `LinkedIn touch: ${input.note}`,
  });
  if (n.reject || !n.draft) return { ok: false, message: n.reject ?? 'invalid input' };

  const existing = getLeadByEmail(n.draft.email);
  const days = input.followUpDays ?? 4;
  const nextTouch = new Date(Date.now() + days * 86400_000).toISOString();
  const now = new Date().toISOString();

  const lead = upsertLead({
    ...n.draft,
    // Don't clobber a stronger existing source (e.g. Past Client) with LinkedIn.
    source: existing?.source && existing.source !== 'Other' ? existing.source : 'LinkedIn',
    lastEngagementAt: now,
    nextTouchAt: nextTouch,
  });

  recordEvent({
    leadId: lead.id,
    type: 'ingest.social_touch',
    trigger: 'log-touch',
    reason: `LinkedIn/social touch logged: ${input.note}`,
    data: { followUpDue: nextTouch },
  });
  slog.info('social touch logged', { email: lead.email, followUpDue: nextTouch });
  return { ok: true, message: `Logged. Follow-up due ${nextTouch.slice(0, 10)}.` };
}
