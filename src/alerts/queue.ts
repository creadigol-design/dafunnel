/**
 * Alert queue. Phase 4 writes alerts here (band changes, HOT crossings); Phase 7
 * reads the queue and delivers to Slack/email with rate limiting + batching.
 *
 * Persisting now means alerts are real and testable before delivery exists — and
 * nothing is lost if delivery is temporarily down.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ALERT_TYPES, type AlertType } from '../../config/alerts.js';

export interface QueueAlertInput {
  leadId?: string | null;
  payload?: Record<string, unknown>;
}

/** Queue an alert for later delivery. Returns its id. */
export function queueAlert(type: AlertType, input: QueueAlertInput = {}): string {
  const id = randomUUID();
  const cfg = ALERT_TYPES[type];
  db()
    .prepare(
      `INSERT INTO alerts_log (id, type, urgency, channel, lead_id, sent_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      type,
      cfg.urgency,
      'queued',
      input.leadId ?? null,
      new Date().toISOString(),
      input.payload ? JSON.stringify(input.payload) : null,
    );
  return id;
}

/** Count queued (undelivered) alerts — used by the doctor + Phase 7. */
export function queuedAlertCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM alerts_log WHERE channel = 'queued'").get() as {
    n: number;
  };
  return row.n;
}
