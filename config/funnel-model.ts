/**
 * The funnel model — the governor's assumptions.
 *
 * IMPORTANT: every rate below is a DEFAULT ASSUMPTION, to be replaced by
 * 90-day actuals once ≥30 data points exist per stage (see src/governor.ts,
 * Phase 7). Until then the governor uses these and says so in its alerts.
 *
 * See docs/FUNNEL-MODEL.md for the reasoning and how actuals replace these.
 */

export interface StageRates {
  /** Fraction of contacts that reply. `null` for inbound (they came to us). */
  contactToReply: number | null;
  /** Fraction of replies that are interested. `null` for inbound. */
  replyToInterested: number | null;
  interestedToCall: number;
  callToProposal: number;
  proposalToWon: number;
  /** Net close rate end-to-end, for quick reference. */
  netCloseRate: number;
}

export type Channel = 'inbound' | 'reactivation' | 'linkedin' | 'cold';

/** Default per-channel conversion rates (assumptions). */
export const DEFAULT_RATES: Record<Channel, StageRates> = {
  inbound: {
    contactToReply: null,
    replyToInterested: null,
    interestedToCall: 0.45,
    callToProposal: 0.75,
    proposalToWon: 0.4,
    netCloseRate: 0.135,
  },
  reactivation: {
    contactToReply: 0.25,
    replyToInterested: 0.55,
    interestedToCall: 0.4,
    callToProposal: 0.7,
    proposalToWon: 0.45,
    netCloseRate: 0.017,
  },
  cold: {
    contactToReply: 0.08,
    replyToInterested: 0.3,
    interestedToCall: 0.55,
    callToProposal: 0.65,
    proposalToWon: 0.3,
    netCloseRate: 0.0026,
  },
  linkedin: {
    contactToReply: 0.18,
    replyToInterested: 0.45,
    interestedToCall: 0.5,
    callToProposal: 0.65,
    proposalToWon: 0.35,
    netCloseRate: 0.009,
  },
};

/** Blended monthly volume plan to hit the target (defaults). */
export const BLENDED_PLAN: Record<Channel, { volumeIn: number; expectedCloses: number }> = {
  inbound: { volumeIn: 8, expectedCloses: 1.1 },
  reactivation: { volumeIn: 15, expectedCloses: 0.25 },
  linkedin: { volumeIn: 35, expectedCloses: 0.3 },
  cold: { volumeIn: 150, expectedCloses: 0.4 },
};

/**
 * The target. Plain-English goal is "2 closes/month", but capacity is the real
 * constraint: ~25 deliverable days/month (1 big job OR 2 small). The governor
 * optimises booked/forecast delivery-days and value, not a raw job count — a
 * single big job fills the month yet counts as one close. Crew is elastic
 * (roster), so Daniel's time + stage-days bind, not headcount.
 */
export const TARGET = {
  closesPerMonth: 2,
  /** Deliverable capacity per month, in shoot/production days. */
  capacityDeliveryDays: 25,
  /** Project value band (GBP). Used for pipeline weighting + cost-per-close. */
  valueBandGbp: { min: 7000, max: 20000 },
  /** Governor thresholds: below → push volume; above → throttle + consider price. */
  projectedFloor: 2.0,
  projectedCeiling: 3.0,
  /** Minimum data points per stage before actuals replace defaults. */
  minDataPointsForActuals: 30,
  /** Rolling window (days) for recomputing actuals. */
  actualsWindowDays: 90,
} as const;

/** Stage-probability weights for forecasting month-end closes from pipeline. */
export const STAGE_PROBABILITY: Record<string, number> = {
  New: 0.02,
  Contacted: 0.05,
  Engaged: 0.1,
  'Discovery Booked': 0.25,
  'Discovery Held': 0.4,
  'Proposal Sent': 0.6,
  Negotiating: 0.8,
  'Closed Won': 1.0,
  'Closed Lost': 0.0,
  Nurture: 0.01,
};
