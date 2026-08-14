/**
 * Alert delivery — drains the queue to Slack (primary) with email fallback.
 *
 * Urgent alerts always break through, immediately, one message each. Non-urgent
 * alerts are BATCHED into a single message per cycle and rate-limited to
 * MAX_NON_URGENT_ALERTS_PER_DAY deliveries/day — an alert system that cries
 * wolf gets muted, and then the whole thing is worthless. Undeliverable alerts
 * stay queued (never lost).
 */
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { ALERT_TYPES, MAX_NON_URGENT_ALERTS_PER_DAY, type AlertType } from '../../config/alerts.js';
import { sendMail } from '../mail/client.js';

const alog = log.child('alerts');

interface QueuedAlert {
  id: string;
  type: AlertType;
  urgency: string;
  lead_id: string | null;
  payload: string | null;
  sent_at: string;
}

async function slackPost(text: string, channel: string): Promise<boolean> {
  if (!config.slack.botToken) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.slack.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) alog.warn('slack post failed', { error: json.error });
    return json.ok;
  } catch (err) {
    alog.warn('slack unreachable', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function leadLabel(leadId: string | null): string {
  if (!leadId) return '';
  const row = db().prepare('SELECT email, company, temperature, score FROM leads WHERE id = ?').get(leadId) as
    | { email: string; company: string | null; temperature: string; score: number }
    | undefined;
  return row ? ` — ${row.email}${row.company ? ` (${row.company})` : ''} [${row.temperature} ${row.score}]` : '';
}

function formatAlert(a: QueuedAlert): string {
  const p = a.payload ? (JSON.parse(a.payload) as Record<string, unknown>) : {};
  const bits = Object.entries(p)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
  return `*${a.type.replaceAll('_', ' ')}*${leadLabel(a.lead_id)}${bits ? `\n  ${bits}` : ''}`;
}

function markDelivered(ids: string[], channel: string): void {
  const stmt = db().prepare("UPDATE alerts_log SET channel = ? WHERE id = ?");
  for (const id of ids) stmt.run(channel, id);
}

function nonUrgentDeliveredToday(asOf: Date): number {
  const dayStart = `${asOf.toISOString().slice(0, 10)}T00:00:00`;
  const row = db()
    .prepare("SELECT COUNT(*) c FROM alerts_log WHERE channel IN ('slack','email') AND urgency != 'urgent' AND sent_at >= ?")
    .get(dayStart) as { c: number };
  return row.c;
}

export interface DeliverSummary {
  urgentSent: number;
  batchedSent: number;
  held: number;
  skipped: boolean;
}

export async function deliverAlerts(asOf: Date = new Date()): Promise<DeliverSummary> {
  const summary: DeliverSummary = { urgentSent: 0, batchedSent: 0, held: 0, skipped: false };
  const queued = db().prepare("SELECT * FROM alerts_log WHERE channel = 'queued' ORDER BY sent_at ASC").all() as QueuedAlert[];
  if (queued.length === 0) return summary;

  if (!config.slack.botToken && !config.mail.pass) {
    summary.skipped = true;
    summary.held = queued.length;
    alog.warn('no delivery channel configured — alerts stay queued', { held: queued.length });
    return summary;
  }

  const urgent = queued.filter((a) => a.urgency === 'urgent');
  const rest = queued.filter((a) => a.urgency !== 'urgent');

  // Urgent: one message each, channel + DM, email fallback where configured.
  for (const a of urgent) {
    const cfg = ALERT_TYPES[a.type] ?? { slack: true, email: false, urgentDm: false };
    const text = `:rotating_light: ${formatAlert(a)}`;
    let ok = false;
    if (cfg.slack) {
      ok = await slackPost(text, config.slack.alertChannel);
      if (cfg.urgentDm && config.slack.urgentDmUser) await slackPost(text, config.slack.urgentDmUser);
    }
    if (!ok && cfg.email && config.mail.pass && !config.dryRun) {
      try {
        await sendMail(config.mail.user, `[vedrí funnel] ${a.type}`, text);
        ok = true;
      } catch { /* stays queued */ }
    }
    if (ok) {
      markDelivered([a.id], 'slack');
      summary.urgentSent++;
    } else summary.held++;
  }

  // Non-urgent: one batched message, rate-limited per day.
  if (rest.length > 0) {
    if (nonUrgentDeliveredToday(asOf) >= MAX_NON_URGENT_ALERTS_PER_DAY) {
      summary.held += rest.length;
    } else {
      const text = `:clipboard: *vedrí funnel — ${rest.length} update${rest.length > 1 ? 's' : ''}*\n\n${rest
        .map(formatAlert)
        .join('\n\n')}`;
      const ok = await slackPost(text, config.slack.alertChannel);
      if (ok) {
        markDelivered(rest.map((a) => a.id), 'slack');
        summary.batchedSent = rest.length;
      } else summary.held += rest.length;
    }
  }

  alog.info('alert delivery pass', { ...summary });
  return summary;
}

/** Build the 08:00 daily digest text from current state. Pure-ish; exported for tests. */
export function buildDailyDigest(asOf: Date = new Date()): string {
  const d = db();
  const pending = d.prepare("SELECT COUNT(*) c FROM drafts WHERE status = 'pending'").get() as { c: number };
  const flagged = d.prepare("SELECT COUNT(*) c FROM drafts WHERE status = 'lint_failed'").get() as { c: number };
  const dayAgo = new Date(asOf.getTime() - 86_400_000).toISOString();
  const moved = d
    .prepare("SELECT COUNT(*) c FROM events WHERE type = 'band.changed' AND created_at >= ?")
    .get(dayAgo) as { c: number };
  const dueToday = d
    .prepare("SELECT COUNT(*) c FROM leads WHERE next_touch_at IS NOT NULL AND next_touch_at <= ?")
    .get(new Date(asOf.getTime() + 86_400_000).toISOString()) as { c: number };
  const hot = d
    .prepare("SELECT email, company, score FROM leads WHERE temperature = 'Hot' ORDER BY score DESC LIMIT 5")
    .all() as { email: string; company: string | null; score: number }[];

  return [
    `:sunrise: *vedrí funnel — daily digest*`,
    ``,
    `• Drafts awaiting your approval: *${pending.c}*${flagged.c ? ` (+${flagged.c} lint-flagged for review)` : ''}`,
    `• Touches due in the next 24h: *${dueToday.c}*`,
    `• Band changes in the last 24h: *${moved.c}*`,
    hot.length
      ? `• Hot leads: ${hot.map((h) => `${h.email}${h.company ? ` (${h.company})` : ''} [${h.score}]`).join(', ')}`
      : `• Hot leads: none yet`,
  ].join('\n');
}

/** Send the daily digest once per day after 08:00 UK. */
export async function maybeSendDailyDigest(asOf: Date = new Date()): Promise<boolean> {
  const ukHour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: config.timezone }).format(asOf),
  );
  if (ukHour < 8) return false;
  const { getSyncState, setSyncState } = await import('../db/index.js');
  const last = getSyncState('digest.daily.last_sent');
  if (last && last.slice(0, 10) === asOf.toISOString().slice(0, 10)) return false;
  const ok = await slackPost(buildDailyDigest(asOf), config.slack.alertChannel);
  if (ok) setSyncState('digest.daily.last_sent', asOf.toISOString());
  return ok;
}
