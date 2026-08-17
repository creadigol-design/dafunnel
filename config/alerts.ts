/**
 * Alert routing configuration (wired up in Phase 7).
 *
 * Two channels: Slack DM/channel (primary) and email fallback. Non-urgent
 * alerts are rate-limited and batched — an alert system that cries wolf gets
 * muted, and then the whole thing is worthless. Urgent alerts always break
 * through the rate limit.
 */

export type AlertUrgency = 'urgent' | 'daily' | 'weekly' | 'monthly';

export interface AlertTypeConfig {
  urgency: AlertUrgency;
  /** Slack primary, email fallback. Both true = both channels. */
  slack: boolean;
  email: boolean;
  /** Urgent alerts additionally DM Daniel to break through the rate limit. */
  urgentDm: boolean;
}

/** Max non-urgent alerts per day (batched). Urgent alerts are exempt. */
export const MAX_NON_URGENT_ALERTS_PER_DAY = 6;

export const ALERT_TYPES = {
  // ── Immediate — always break through ──────────────────────────────────────
  new_inbound_enquiry: { urgency: 'urgent', slack: true, email: true, urgentDm: true },
  decision_matrix_submission: { urgency: 'urgent', slack: true, email: true, urgentDm: true },
  lead_became_hot: { urgency: 'urgent', slack: true, email: false, urgentDm: true },
  positive_reply: { urgency: 'urgent', slack: true, email: false, urgentDm: true },
  discovery_booked: { urgency: 'urgent', slack: true, email: false, urgentDm: true },
  deal_won: { urgency: 'urgent', slack: true, email: true, urgentDm: true },
  system_failure: { urgency: 'urgent', slack: true, email: true, urgentDm: true },

  // ── Batched digests ───────────────────────────────────────────────────────
  daily_digest: { urgency: 'daily', slack: true, email: true, urgentDm: false },
  weekly_pace: { urgency: 'weekly', slack: true, email: true, urgentDm: false },
  monthly_report: { urgency: 'monthly', slack: true, email: true, urgentDm: false },

  // ── Governor + housekeeping (non-urgent) ──────────────────────────────────
  governor_recommendation: { urgency: 'daily', slack: true, email: false, urgentDm: false },
  band_change: { urgency: 'daily', slack: true, email: false, urgentDm: false },
  freetier_ceiling_warning: { urgency: 'daily', slack: true, email: true, urgentDm: false },
  needs_input_flagged: { urgency: 'daily', slack: true, email: false, urgentDm: false },
  prospects_found: { urgency: 'daily', slack: true, email: false, urgentDm: false },
  ig_dm_followup: { urgency: 'daily', slack: true, email: false, urgentDm: false },
} as const satisfies Record<string, AlertTypeConfig>;

export type AlertType = keyof typeof ALERT_TYPES;
