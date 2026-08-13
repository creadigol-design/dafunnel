/**
 * Reconciliation: merge a local Lead with its HubSpot contact on each cycle.
 *
 * Rule (from the brief): HubSpot wins on human-edited fields; we win on machine
 * fields. So if Daniel corrects a name, company, track or source in the HubSpot
 * UI, that flows back into our SQLite mirror; but score, temperature, sequence
 * position and suppression are ours and get pushed up.
 *
 * Pure and deterministic — unit-tested. Returns both the merged Lead (to persist
 * locally) and the machine-owned properties to push to HubSpot.
 */
import type { Lead } from '../types.js';
import { contactToLeadPatch, leadToMachineProperties, HUMAN_OWNED_FIELDS } from './mapping.js';
import type { HubSpotContact } from './client.js';

/** Maps a HubSpot property name to the Lead field it patches (human-owned only). */
const HUMAN_PROP_TO_LEAD: Record<string, keyof Lead> = {
  firstname: 'firstName',
  lastname: 'lastName',
  company: 'company',
  vedri_track: 'track',
  vedri_source: 'source',
  vedri_lia_basis: 'liaBasis',
  vedri_internal_notes: 'internalNotes',
};

export interface ReconcileResult {
  /** The merged lead to persist locally. */
  lead: Lead;
  /** Machine-owned properties to push up to HubSpot. */
  pushProperties: Record<string, string>;
  /** Human fields HubSpot overrode locally (for the audit event). */
  humanOverrides: string[];
}

/**
 * Merge a local lead with the remote contact.
 * - Human-owned remote values overwrite the local lead.
 * - Machine-owned local values are staged to push up.
 */
export function reconcile(local: Lead, remote: HubSpotContact): ReconcileResult {
  const patch = contactToLeadPatch(remote.properties);
  const merged: Lead = { ...local, hubspotContactId: remote.id };
  const humanOverrides: string[] = [];

  for (const [prop, leadField] of Object.entries(HUMAN_PROP_TO_LEAD)) {
    if (!HUMAN_OWNED_FIELDS.has(prop)) continue;
    const remoteVal = (patch as Record<string, unknown>)[leadField as string];
    if (remoteVal === undefined) continue;
    const localVal = (local as unknown as Record<string, unknown>)[leadField as string];
    if (remoteVal !== localVal) {
      (merged as unknown as Record<string, unknown>)[leadField as string] = remoteVal;
      humanOverrides.push(prop);
    }
  }

  merged.updatedAt = new Date().toISOString();
  return {
    lead: merged,
    pushProperties: leadToMachineProperties(merged),
    humanOverrides,
  };
}
