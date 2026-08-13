/**
 * Scoring engine — the temperature spine.
 *
 * Design principle: a lead's score is a PURE FUNCTION of its event log and the
 * clock — `score = clamp(sum(positive signals) − decay(daysSinceEngagement))`.
 * Nothing mutates a score directly; signals and transitions are recorded as
 * events, and the score is recomputed from them. This makes scoring idempotent,
 * replayable, and fully explainable ("why is this hot?" = read the events).
 *
 * Bands: COLD 0–24 · WARM 25–54 · HOT 55–100, plus terminal Closed Won/Lost,
 * Suppressed, Disqualified, and the sticky Nurture (floor 15). Every band change
 * queues an alert.
 */
import { BAND_THRESHOLDS, type Temperature } from './types.js';
import { log } from './logger.js';
import { db } from './db/index.js';
import { recordEvent } from './db/events.js';
import { getLeadById, saveLead, allLeads } from './db/leads.js';
import { queueAlert } from './alerts/queue.js';

const slog = log.child('scoring');

/** Additive positive signals and their point values (from the brief). */
export type PositiveSignal =
  | 'email_opened' // 2+ distinct opens, same message
  | 'link_clicked'
  | 'visited_pricing'
  | 'completed_decision_matrix'
  | 'reply_neutral'
  | 'reply_positive'
  | 'asked_question'
  | 'asked_for_quote'
  | 'discovery_booked'
  | 'discovery_attended'
  | 'proposal_sent'
  | 'named_budget_or_date'
  | 'forwarded_cc'
  | 'icp_fit_bonus'
  | 'prior_client';

export const SIGNAL_POINTS: Record<PositiveSignal, number> = {
  email_opened: 4,
  link_clicked: 8,
  visited_pricing: 10,
  completed_decision_matrix: 30,
  reply_neutral: 12,
  reply_positive: 35,
  asked_question: 15,
  asked_for_quote: 30,
  discovery_booked: 40,
  discovery_attended: 15,
  proposal_sent: 20,
  named_budget_or_date: 20,
  forwarded_cc: 15,
  icp_fit_bonus: 10,
  prior_client: 15,
};

export type TerminalTransition =
  | 'reply_negative' // → Nurture, floor 15, no touch 90 days
  | 'hard_no' // → Suppressed, permanent
  | 'bounce_hard' // → Disqualified
  | 'five_touches_no_engagement'; // → Nurture

const DECAY_PER_WEEK = 3;
const NURTURE_FLOOR = 15;
const NURTURE_QUIET_DAYS = 90;
const TERMINAL: ReadonlySet<Temperature> = new Set([
  'Closed Won',
  'Closed Lost',
  'Suppressed',
  'Disqualified',
]);

export function isTerminal(band: Temperature): boolean {
  return TERMINAL.has(band);
}

export function clampScore(n: number): number {
  return Math.max(BAND_THRESHOLDS.SCORE_MIN, Math.min(BAND_THRESHOLDS.SCORE_MAX, Math.round(n)));
}

/** Map a numeric score to its band (non-terminal only). */
export function computeBand(score: number): Temperature {
  if (score >= BAND_THRESHOLDS.HOT_MIN) return 'Hot';
  if (score >= BAND_THRESHOLDS.WARM_MIN) return 'Warm';
  return 'Cold';
}

function daysBetween(fromIso: string, to: Date): number {
  const d = Math.floor((to.getTime() - Date.parse(fromIso)) / 86_400_000);
  return d > 0 ? d : 0;
}

/** −3 points per full 7 days since the last inbound engagement. */
export function decayPoints(lastEngagementAt: string | null, createdAt: string, asOf: Date): number {
  const ref = lastEngagementAt ?? createdAt;
  const weeks = Math.floor(daysBetween(ref, asOf) / 7);
  return weeks * DECAY_PER_WEEK;
}

/** Sum of positive-signal points recorded for a lead. */
export function sumSignalPoints(leadId: string): number {
  const rows = db()
    .prepare("SELECT data FROM events WHERE lead_id = ? AND type = 'score.signal'")
    .all(leadId) as { data: string | null }[];
  let total = 0;
  for (const r of rows) {
    if (!r.data) continue;
    const points = (JSON.parse(r.data) as { points?: number }).points;
    if (typeof points === 'number') total += points;
  }
  return total;
}

function signalAlreadyApplied(leadId: string, key: string): boolean {
  const row = db()
    .prepare(
      "SELECT 1 FROM events WHERE lead_id = ? AND type = 'score.signal' AND json_extract(data, '$.key') = ? LIMIT 1",
    )
    .get(leadId, key);
  return Boolean(row);
}

export interface ScoreResult {
  leadId: string;
  oldScore: number;
  newScore: number;
  oldBand: Temperature;
  newBand: Temperature;
  bandChanged: boolean;
}

/** Recompute a lead's score from its events + the clock, persisting changes. */
export function recomputeScore(leadId: string, trigger: string, asOf: Date = new Date()): ScoreResult {
  const lead = getLeadById(leadId);
  if (!lead) throw new Error(`recomputeScore: no lead ${leadId}`);
  const oldScore = lead.score;
  const oldBand = lead.temperature;

  if (isTerminal(oldBand)) {
    return { leadId, oldScore, newScore: oldScore, oldBand, newBand: oldBand, bandChanged: false };
  }

  const base = sumSignalPoints(leadId);
  const decay = decayPoints(lead.lastEngagementAt, lead.createdAt, asOf);
  const raw = base - decay;

  let newScore: number;
  let newBand: Temperature;
  if (oldBand === 'Nurture') {
    // Sticky at the floor unless strongly re-engaged (crosses HOT).
    if (raw >= BAND_THRESHOLDS.HOT_MIN) {
      newScore = clampScore(raw);
      newBand = computeBand(newScore);
    } else {
      newScore = Math.max(NURTURE_FLOOR, clampScore(raw));
      newBand = 'Nurture';
    }
  } else {
    newScore = clampScore(raw);
    newBand = computeBand(newScore);
  }

  const bandChanged = newBand !== oldBand;
  if (newScore !== oldScore || bandChanged) {
    saveLead({
      ...lead,
      score: newScore,
      temperature: newBand,
      scoreUpdatedAt: asOf.toISOString(),
      updatedAt: asOf.toISOString(),
    });
    recordEvent({
      leadId,
      type: 'score.recomputed',
      trigger,
      oldScore,
      newScore,
      reason: `base ${base} − decay ${decay} = ${newScore} (${newBand})`,
    });
  }
  if (bandChanged) handleBandChange(leadId, oldBand, newBand, newScore, trigger);

  return { leadId, oldScore, newScore, oldBand, newBand, bandChanged };
}

function handleBandChange(
  leadId: string,
  oldBand: Temperature,
  newBand: Temperature,
  score: number,
  trigger: string,
): void {
  recordEvent({
    leadId,
    type: 'band.changed',
    trigger,
    reason: `${oldBand} → ${newBand}`,
    data: { oldBand, newBand, score },
  });
  // Crossing into HOT is urgent; every other band change is a batched alert.
  queueAlert(newBand === 'Hot' ? 'lead_became_hot' : 'band_change', {
    leadId,
    payload: { oldBand, newBand, score },
  });
  slog.info('band change', { leadId, from: oldBand, to: newBand, score });
}

export interface ApplySignalOptions {
  trigger: string;
  reason?: string;
  /** Stable key for one-time signals; re-applying with the same key is a no-op. */
  idempotencyKey?: string;
  asOf?: Date;
  /**
   * Whether this signal counts as engagement and resets the decay clock
   * (default true). Seed bonuses (prior-client, ICP fit) pass false — they add
   * points but aren't a fresh interaction.
   */
  engagement?: boolean;
}

/** Record a positive signal and recompute. Returns null if idempotently skipped. */
export function applySignal(
  leadId: string,
  signal: PositiveSignal,
  opts: ApplySignalOptions,
): ScoreResult | null {
  if (opts.idempotencyKey && signalAlreadyApplied(leadId, opts.idempotencyKey)) return null;
  const asOf = opts.asOf ?? new Date();
  const points = SIGNAL_POINTS[signal];
  recordEvent({
    leadId,
    type: 'score.signal',
    trigger: opts.trigger,
    reason: opts.reason ?? `${signal} (+${points})`,
    data: { signal, points, key: opts.idempotencyKey ?? null },
  });
  // Real engagement resets the decay clock so warmth is measured from the last
  // genuine interaction, not from record creation.
  if (opts.engagement !== false) {
    const lead = getLeadById(leadId);
    if (lead && !isTerminal(lead.temperature)) {
      saveLead({ ...lead, lastEngagementAt: asOf.toISOString(), updatedAt: asOf.toISOString() });
    }
  }
  return recomputeScore(leadId, opts.trigger, asOf);
}

/** Apply a terminal/holding transition (negative reply, hard no, bounce, dead). */
export function applyTransition(
  leadId: string,
  transition: TerminalTransition,
  opts: { trigger: string; reason?: string; asOf?: Date },
): ScoreResult {
  const lead = getLeadById(leadId);
  if (!lead) throw new Error(`applyTransition: no lead ${leadId}`);
  const asOf = opts.asOf ?? new Date();
  const oldBand = lead.temperature;
  const oldScore = lead.score;

  let newBand: Temperature;
  let newScore = lead.score;
  const patch = { ...lead, updatedAt: asOf.toISOString(), scoreUpdatedAt: asOf.toISOString() };

  switch (transition) {
    case 'hard_no': {
      newBand = 'Suppressed';
      patch.suppressed = true;
      patch.suppressionReason = opts.reason ?? 'Hard no / unsubscribe';
      addSuppression(lead.email, patch.suppressionReason);
      break;
    }
    case 'bounce_hard': {
      newBand = 'Disqualified';
      break;
    }
    case 'reply_negative':
    case 'five_touches_no_engagement': {
      newBand = 'Nurture';
      newScore = Math.max(NURTURE_FLOOR, lead.score);
      patch.nextTouchAt = new Date(asOf.getTime() + NURTURE_QUIET_DAYS * 86_400_000).toISOString();
      break;
    }
  }

  patch.temperature = newBand;
  patch.score = newScore;
  saveLead(patch);
  recordEvent({
    leadId,
    type: 'transition',
    trigger: opts.trigger,
    oldScore,
    newScore,
    reason: `${transition}: ${oldBand} → ${newBand}${opts.reason ? ` (${opts.reason})` : ''}`,
    data: { transition },
  });
  if (newBand !== oldBand) handleBandChange(leadId, oldBand, newBand, newScore, opts.trigger);
  return { leadId, oldScore, newScore, oldBand, newBand, bandChanged: newBand !== oldBand };
}

function addSuppression(email: string, reason: string): void {
  db()
    .prepare(
      `INSERT INTO suppression (email, reason, source, created_at)
       VALUES (?, ?, 'scoring', ?) ON CONFLICT(email) DO NOTHING`,
    )
    .run(email.toLowerCase(), reason, new Date().toISOString());
}

/** Apply one-time seed bonuses (prior client, ICP fit) idempotently. */
export function ensureSeedSignals(leadId: string, asOf?: Date): void {
  const lead = getLeadById(leadId);
  if (!lead || isTerminal(lead.temperature)) return;
  if (lead.source === 'Past Client') {
    applySignal(leadId, 'prior_client', {
      trigger: 'seed',
      idempotencyKey: 'seed:prior_client',
      engagement: false,
      asOf,
    });
  }
  if (lead.icpFit === 'High') {
    applySignal(leadId, 'icp_fit_bonus', {
      trigger: 'seed',
      idempotencyKey: 'seed:icp_fit',
      engagement: false,
      asOf,
    });
  }
}

export interface ScoringRunSummary {
  scored: number;
  bandChanges: number;
  hot: number;
}

/** Nightly pass: seed bonuses, then recompute + decay every non-terminal lead. */
export function runScoring(asOf: Date = new Date()): ScoringRunSummary {
  let bandChanges = 0;
  let hot = 0;
  let scored = 0;
  for (const lead of allLeads()) {
    if (isTerminal(lead.temperature)) continue;
    ensureSeedSignals(lead.id, asOf);
    const r = recomputeScore(lead.id, 'nightly-cycle', asOf);
    scored++;
    if (r.bandChanged) bandChanges++;
    if (r.newBand === 'Hot') hot++;
  }
  slog.info('scoring run complete', { scored, bandChanges, hot });
  return { scored, bandChanges, hot };
}
