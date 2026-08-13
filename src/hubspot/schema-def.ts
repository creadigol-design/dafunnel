/**
 * HubSpot schema definition — the single source of truth for provisioning.
 *
 * `scripts/provision-hubspot.ts` reads this and creates everything idempotently.
 * All custom fields are prefixed `vedri_` so it is obvious what we own.
 *
 * FREE-TIER NOTE: HubSpot free CRM allows exactly ONE deal pipeline (verified
 * against portal 149092923 — only the default "Sales Pipeline" exists, and
 * multiple pipelines require paid Sales Hub Starter+). So we run a SINGLE
 * pipeline and split Studio vs VFX with the `vedri_track` property. If the
 * account is ever upgraded, set HUBSPOT_SEPARATE_PIPELINES=true to provision two.
 */

export type PropertyType =
  | { type: 'string'; fieldType: 'text' | 'textarea' }
  | { type: 'number'; fieldType: 'number' }
  | { type: 'datetime'; fieldType: 'date' }
  | { type: 'bool'; fieldType: 'booleancheckbox' }
  | { type: 'enumeration'; fieldType: 'select'; options: string[] };

export interface PropertyDef {
  name: string;
  label: string;
  description: string;
  spec: PropertyType;
  /** True for fields a human edits in HubSpot (reconciliation: HubSpot wins). */
  humanOwned: boolean;
}

/** The property group all vedri_ contact fields live under. */
export const CONTACT_GROUP = { name: 'vedri_funnel', label: 'vedrí Funnel' } as const;
export const DEAL_GROUP = { name: 'vedri_funnel', label: 'vedrí Funnel' } as const;

function enumOpts(values: string[]): PropertyType {
  return { type: 'enumeration', fieldType: 'select', options: values };
}

export const CONTACT_PROPERTIES: PropertyDef[] = [
  { name: 'vedri_track', label: 'vedrí Track', description: 'Which brand track this contact belongs to.', spec: enumOpts(['Studio', 'VFX', 'Both']), humanOwned: true },
  { name: 'vedri_temperature', label: 'vedrí Temperature', description: 'Lifecycle band derived from score + events.', spec: enumOpts(['Cold', 'Warm', 'Hot', 'Closed Won', 'Closed Lost', 'Nurture', 'Disqualified', 'Suppressed']), humanOwned: false },
  { name: 'vedri_score', label: 'vedrí Score', description: 'Engagement score 0–100.', spec: { type: 'number', fieldType: 'number' }, humanOwned: false },
  { name: 'vedri_score_updated', label: 'vedrí Score Updated', description: 'When the score was last recomputed.', spec: { type: 'datetime', fieldType: 'date' }, humanOwned: false },
  { name: 'vedri_source', label: 'vedrí Source', description: 'Where this lead entered the funnel.', spec: enumOpts(['Inbound Form', 'Decision Matrix', 'Mailchimp Signup', 'Built List', 'LinkedIn', 'Past Client', 'Referral', 'Other']), humanOwned: true },
  { name: 'vedri_sequence', label: 'vedrí Sequence', description: 'Active sequence id.', spec: { type: 'string', fieldType: 'text' }, humanOwned: false },
  { name: 'vedri_sequence_step', label: 'vedrí Sequence Step', description: 'Current step index in the sequence.', spec: { type: 'number', fieldType: 'number' }, humanOwned: false },
  { name: 'vedri_next_touch_at', label: 'vedrí Next Touch At', description: 'When the next touch is due.', spec: { type: 'datetime', fieldType: 'date' }, humanOwned: false },
  { name: 'vedri_last_engagement_at', label: 'vedrí Last Engagement At', description: 'Last inbound engagement timestamp.', spec: { type: 'datetime', fieldType: 'date' }, humanOwned: false },
  { name: 'vedri_icp_fit', label: 'vedrí ICP Fit', description: 'Ideal-customer-profile fit grade.', spec: enumOpts(['High', 'Medium', 'Low']), humanOwned: false },
  { name: 'vedri_suppressed', label: 'vedrí Suppressed', description: 'Permanent do-not-contact flag.', spec: { type: 'bool', fieldType: 'booleancheckbox' }, humanOwned: false },
  { name: 'vedri_suppression_reason', label: 'vedrí Suppression Reason', description: 'Why the contact was suppressed.', spec: { type: 'string', fieldType: 'text' }, humanOwned: false },
  { name: 'vedri_lia_basis', label: 'vedrí LIA Basis', description: 'Legitimate-interest assessment record (UK GDPR/PECR).', spec: { type: 'string', fieldType: 'textarea' }, humanOwned: true },
  { name: 'vedri_needs_input', label: 'vedrí Needs Input', description: 'Unresolved {{NEEDS_INPUT}} tokens awaiting Daniel.', spec: { type: 'string', fieldType: 'textarea' }, humanOwned: false },
  { name: 'vedri_recommended_approach', label: 'vedrí Recommended Approach', description: 'VP approach from the decision matrix.', spec: enumOpts(['Green Screen', '2D Plates LED', '3D Unreal LED', 'Hybrid']), humanOwned: false },
  { name: 'vedri_internal_notes', label: 'vedrí Internal Notes', description: 'INTERNAL ONLY — kit list + quiz answers. Never client-facing.', spec: { type: 'string', fieldType: 'textarea' }, humanOwned: true },
];

export const DEAL_PROPERTIES: PropertyDef[] = [
  { name: 'vedri_track', label: 'vedrí Track', description: 'Studio or VFX (splits the shared pipeline).', spec: enumOpts(['Studio', 'VFX']), humanOwned: true },
  { name: 'vedri_approach', label: 'vedrí Approach', description: 'Recommended VP approach for the job.', spec: enumOpts(['Green Screen', '2D Plates LED', '3D Unreal LED', 'Hybrid']), humanOwned: true },
  { name: 'vedri_shoot_dates', label: 'vedrí Shoot Dates', description: 'Proposed / booked shoot dates.', spec: { type: 'string', fieldType: 'text' }, humanOwned: true },
  { name: 'vedri_est_value', label: 'vedrí Estimated Value', description: 'Estimated job value (GBP).', spec: { type: 'number', fieldType: 'number' }, humanOwned: true },
  { name: 'vedri_proposal_sent_at', label: 'vedrí Proposal Sent At', description: 'When the proposal was sent.', spec: { type: 'datetime', fieldType: 'date' }, humanOwned: false },
  { name: 'vedri_stage_entered_at', label: 'vedrí Stage Entered At', description: 'When the deal entered its current stage.', spec: { type: 'datetime', fieldType: 'date' }, humanOwned: false },
  { name: 'vedri_days_in_stage', label: 'vedrí Days In Stage', description: 'Days the deal has sat in its current stage.', spec: { type: 'number', fieldType: 'number' }, humanOwned: false },
];

/** Shared pipeline stages. `probability` feeds the governor's forecast. */
export interface StageDef {
  label: string;
  probability: number;
  /** HubSpot closed states. */
  closed?: 'won' | 'lost';
}

export const PIPELINE_LABEL = 'vedrí Sales';
export const PIPELINE_STAGES: StageDef[] = [
  { label: 'New', probability: 0.02 },
  { label: 'Contacted', probability: 0.05 },
  { label: 'Engaged', probability: 0.1 },
  { label: 'Discovery Booked', probability: 0.25 },
  { label: 'Discovery Held', probability: 0.4 },
  { label: 'Proposal Sent', probability: 0.6 },
  { label: 'Negotiating', probability: 0.8 },
  { label: 'Closed Won', probability: 1.0, closed: 'won' },
  { label: 'Closed Lost', probability: 0.0, closed: 'lost' },
  { label: 'Nurture', probability: 0.01 },
];
