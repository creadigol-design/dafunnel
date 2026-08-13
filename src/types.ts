/**
 * Core domain vocabulary for the vedrí funnel.
 *
 * These types are the shared contract between ingestion, scoring, sequencing,
 * reply handling, alerts and the dashboard. Keep them narrow and explicit —
 * the scoring state machine (Phase 4) depends on these unions being exhaustive.
 */

/** The two brand tracks that run off one engine. */
export type Track = 'Studio' | 'VFX' | 'Both';

/**
 * Temperature bands. COLD/WARM/HOT are score-derived; the rest are terminal or
 * holding states set by explicit events. Every band change fires an alert.
 */
export type Temperature =
  | 'Cold' // score 0–24
  | 'Warm' // score 25–54
  | 'Hot' // score 55–100
  | 'Closed Won'
  | 'Closed Lost'
  | 'Nurture'
  | 'Disqualified'
  | 'Suppressed';

/** Score band thresholds. Single source of truth for scoring.ts (Phase 4). */
export const BAND_THRESHOLDS = {
  WARM_MIN: 25,
  HOT_MIN: 55,
  SCORE_MIN: 0,
  SCORE_MAX: 100,
} as const;

/** Where a lead came from — drives which sequence and conversion model applies. */
export type LeadSource =
  | 'Inbound Form'
  | 'Decision Matrix'
  | 'Mailchimp Signup' // opted in via the website → carries consent (PECR-friendly)
  | 'Built List'
  | 'LinkedIn'
  | 'Past Client'
  | 'Referral'
  | 'Other';

/** ICP-fit grade; feeds the +10 scoring bonus and prioritisation. */
export type IcpFit = 'High' | 'Medium' | 'Low';

/** VP approach recommended by the decision matrix (mirrors vedri-studio ref). */
export type RecommendedApproach =
  | 'Green Screen'
  | '2D Plates LED'
  | '3D Unreal LED'
  | 'Hybrid';

/** Shared deal-pipeline stages across both Studio and VFX pipelines. */
export type PipelineStage =
  | 'New'
  | 'Contacted'
  | 'Engaged'
  | 'Discovery Booked'
  | 'Discovery Held'
  | 'Proposal Sent'
  | 'Negotiating'
  | 'Closed Won'
  | 'Closed Lost'
  | 'Nurture';

/** Which mailbox a message goes out from — warm inbox vs cold sending domain. */
export type Mailbox = 'warm' | 'cold';

/**
 * Reply intent classes (Phase 6). Classification below 0.8 confidence takes no
 * automated action and escalates the raw text to Daniel.
 */
export type ReplyClass =
  | 'POSITIVE_INTERESTED'
  | 'POSITIVE_LATER'
  | 'QUESTION'
  | 'REFERRAL_REDIRECT'
  | 'NEUTRAL_OOO'
  | 'NEGATIVE_NOT_INTERESTED'
  | 'HARD_NO_REMOVE'
  | 'AUTO_REPLY'
  | 'BOUNCE';

/**
 * The normalised lead every ingestion adapter produces. Dedupe key is
 * (email, companyDomain). Machine-owned fields; HubSpot wins on human-edited
 * fields during reconciliation, we win on machine fields.
 */
export interface Lead {
  /** Local UUID; stable across the lead's life. */
  id: string;
  email: string;
  /** Lower-cased domain parsed from email or company site; part of dedupe key. */
  companyDomain: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  track: Track;
  source: LeadSource;
  temperature: Temperature;
  score: number;
  icpFit: IcpFit | null;
  recommendedApproach: RecommendedApproach | null;
  /** Internal-only notes (kit list, quiz answers). NEVER enters client copy. */
  internalNotes: string | null;
  /** Legitimate-interest assessment basis (UK GDPR/PECR record). */
  liaBasis: string | null;
  /** Unresolved {{NEEDS_INPUT: ...}} tokens surfaced to the review queue. */
  needsInput: string | null;
  /** Flagged sole trader / unincorporated partnership → needs consent. */
  needsConsent: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  sequenceId: string | null;
  sequenceStep: number | null;
  nextTouchAt: string | null; // ISO 8601
  lastEngagementAt: string | null; // ISO 8601
  scoreUpdatedAt: string | null; // ISO 8601
  /** HubSpot contact id once synced; null until then. */
  hubspotContactId: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Append-only audit event. The scoring engine, sync, sends and classification
 * all write here so "why is this lead hot?" always has a straight answer.
 */
export interface FunnelEvent {
  id: string;
  leadId: string | null;
  /** Machine-readable event type, e.g. 'score.changed', 'reply.classified'. */
  type: string;
  /** What triggered it, e.g. 'nightly-decay', 'gmail-poll', 'form-submit'. */
  trigger: string;
  oldScore: number | null;
  newScore: number | null;
  /** Human-readable reason string. */
  reason: string;
  /** Arbitrary structured payload as JSON. */
  data: Record<string, unknown> | null;
  createdAt: string; // ISO 8601
}
