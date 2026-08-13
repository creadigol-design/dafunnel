/**
 * Pure mapping between our local `Lead` and HubSpot contact properties.
 *
 * No I/O here — this is unit-tested hard (both directions) because a silent
 * mapping bug corrupts the system of record. Field ownership (who wins on
 * conflict) is derived from the `humanOwned` flags in schema-def so there is one
 * source of truth.
 */
import type {
  Lead,
  Track,
  Temperature,
  LeadSource,
  IcpFit,
  RecommendedApproach,
} from '../types.js';
import { CONTACT_PROPERTIES } from './schema-def.js';

/** Standard HubSpot contact fields we treat as human-owned. */
export const STANDARD_HUMAN_FIELDS = ['email', 'firstname', 'lastname', 'company'] as const;

/** Property names HubSpot wins on during reconciliation (human-edited). */
export const HUMAN_OWNED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...STANDARD_HUMAN_FIELDS,
  ...CONTACT_PROPERTIES.filter((p) => p.humanOwned).map((p) => p.name),
]);

/** Property names we win on during reconciliation (machine-computed). */
export const MACHINE_OWNED_FIELDS: ReadonlySet<string> = new Set<string>(
  CONTACT_PROPERTIES.filter((p) => !p.humanOwned).map((p) => p.name),
);

/** Serialise a Lead into a full HubSpot contact property map (omitting nulls). */
export function leadToContactProperties(lead: Lead): Record<string, string> {
  const p: Record<string, string> = { email: lead.email };
  set(p, 'firstname', lead.firstName);
  set(p, 'lastname', lead.lastName);
  set(p, 'company', lead.company);
  set(p, 'vedri_track', lead.track);
  set(p, 'vedri_temperature', lead.temperature);
  set(p, 'vedri_score', String(lead.score));
  set(p, 'vedri_score_updated', lead.scoreUpdatedAt);
  set(p, 'vedri_source', lead.source);
  set(p, 'vedri_sequence', lead.sequenceId);
  set(p, 'vedri_sequence_step', lead.sequenceStep != null ? String(lead.sequenceStep) : null);
  set(p, 'vedri_next_touch_at', lead.nextTouchAt);
  set(p, 'vedri_last_engagement_at', lead.lastEngagementAt);
  set(p, 'vedri_icp_fit', lead.icpFit);
  set(p, 'vedri_suppressed', lead.suppressed ? 'true' : 'false');
  set(p, 'vedri_suppression_reason', lead.suppressionReason);
  set(p, 'vedri_lia_basis', lead.liaBasis);
  set(p, 'vedri_needs_input', lead.needsInput);
  set(p, 'vedri_recommended_approach', lead.recommendedApproach);
  set(p, 'vedri_internal_notes', lead.internalNotes);
  return p;
}

/** Just the machine-owned subset — what we push to HubSpot on sync. */
export function leadToMachineProperties(lead: Lead): Record<string, string> {
  const all = leadToContactProperties(lead);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (MACHINE_OWNED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/** Parse HubSpot contact properties into a partial Lead patch. */
export function contactToLeadPatch(props: Record<string, string | null>): Partial<Lead> {
  const patch: Partial<Lead> = {};
  assign(patch, 'firstName', props.firstname);
  assign(patch, 'lastName', props.lastname);
  assign(patch, 'company', props.company);
  if (props.vedri_track) patch.track = props.vedri_track as Track;
  if (props.vedri_temperature) patch.temperature = props.vedri_temperature as Temperature;
  if (props.vedri_score != null && props.vedri_score !== '') patch.score = Number(props.vedri_score);
  assign(patch, 'scoreUpdatedAt', props.vedri_score_updated);
  if (props.vedri_source) patch.source = props.vedri_source as LeadSource;
  assign(patch, 'sequenceId', props.vedri_sequence);
  if (props.vedri_sequence_step != null && props.vedri_sequence_step !== '') {
    patch.sequenceStep = Number(props.vedri_sequence_step);
  }
  assign(patch, 'nextTouchAt', props.vedri_next_touch_at);
  assign(patch, 'lastEngagementAt', props.vedri_last_engagement_at);
  if (props.vedri_icp_fit) patch.icpFit = props.vedri_icp_fit as IcpFit;
  if (props.vedri_suppressed != null) patch.suppressed = props.vedri_suppressed === 'true';
  assign(patch, 'suppressionReason', props.vedri_suppression_reason);
  assign(patch, 'liaBasis', props.vedri_lia_basis);
  assign(patch, 'needsInput', props.vedri_needs_input);
  if (props.vedri_recommended_approach) {
    patch.recommendedApproach = props.vedri_recommended_approach as RecommendedApproach;
  }
  assign(patch, 'internalNotes', props.vedri_internal_notes);
  return patch;
}

function set(target: Record<string, string>, key: string, value: string | null | undefined): void {
  if (value != null && value !== '') target[key] = value;
}

function assign<T, K extends keyof T>(target: T, key: K, value: string | null | undefined): void {
  if (value != null && value !== '') (target as Record<string, unknown>)[key as string] = value;
}
