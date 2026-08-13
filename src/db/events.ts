/**
 * Append-only event log helpers.
 *
 * Every score change, sync, send, classification and band transition writes an
 * event here. This is what makes `pnpm run explain <email>` able to answer "why
 * is this lead hot?" with a straight, timestamped chain of reasons.
 *
 * Rows are INSERT-only. Nothing in the codebase updates or deletes an event.
 */
import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import type { FunnelEvent } from '../types.js';

export interface RecordEventInput {
  leadId?: string | null;
  type: string;
  trigger: string;
  oldScore?: number | null;
  newScore?: number | null;
  reason: string;
  data?: Record<string, unknown> | null;
}

/** Append one event. Returns its generated id. */
export function recordEvent(input: RecordEventInput): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO events (id, lead_id, type, trigger, old_score, new_score, reason, data, created_at)
       VALUES (@id, @leadId, @type, @trigger, @oldScore, @newScore, @reason, @data, @createdAt)`,
    )
    .run({
      id,
      leadId: input.leadId ?? null,
      type: input.type,
      trigger: input.trigger,
      oldScore: input.oldScore ?? null,
      newScore: input.newScore ?? null,
      reason: input.reason,
      data: input.data ? JSON.stringify(input.data) : null,
      createdAt: new Date().toISOString(),
    });
  return id;
}

/** Full event history for a lead, oldest first — the basis of `explain`. */
export function eventsForLead(leadId: string): FunnelEvent[] {
  const rows = db()
    .prepare('SELECT * FROM events WHERE lead_id = ? ORDER BY created_at ASC')
    .all(leadId) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

function rowToEvent(r: Record<string, unknown>): FunnelEvent {
  return {
    id: r.id as string,
    leadId: (r.lead_id as string | null) ?? null,
    type: r.type as string,
    trigger: r.trigger as string,
    oldScore: (r.old_score as number | null) ?? null,
    newScore: (r.new_score as number | null) ?? null,
    reason: r.reason as string,
    data: r.data ? (JSON.parse(r.data as string) as Record<string, unknown>) : null,
    createdAt: r.created_at as string,
  };
}
