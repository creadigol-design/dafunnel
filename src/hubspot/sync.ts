/**
 * Bidirectional sync + reconciliation between SQLite and HubSpot.
 *
 * For each local lead: find its HubSpot contact (by stored id, else by email).
 *  - If it exists  → reconcile (HubSpot wins human fields, we win machine
 *    fields), persist the merged lead locally, push machine props up.
 *  - If it doesn't → create it in HubSpot from the lead, store the contact id.
 *
 * DRY_RUN gates every write: reads still happen (so you can see what would sync),
 * but no create/update touches HubSpot. Without a token, sync is skipped whole.
 *
 * Pulling brand-new HubSpot-only contacts into the funnel is an ingestion
 * concern (Phase 3), not sync.
 */
import { config } from '../../config/index.js';
import type { Lead } from '../types.js';
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { setSyncState } from '../db/index.js';
import { allLeads, saveLead, getLeadByEmail, upsertLead } from '../db/leads.js';
import { applySignal } from '../scoring.js';
import { HubSpotClient } from './client.js';
import {
  leadToContactProperties,
  contactToLeadPatch,
  HUMAN_OWNED_FIELDS,
  MACHINE_OWNED_FIELDS,
} from './mapping.js';
import { reconcile } from './reconcile.js';

const slog = log.child('sync');

/** Property names to request when reading a contact back for reconciliation. */
const READ_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'company',
  ...Array.from(HUMAN_OWNED_FIELDS),
  ...Array.from(MACHINE_OWNED_FIELDS),
].filter((v, i, a) => a.indexOf(v) === i);

export interface SyncSummary {
  reconciled: number;
  created: number;
  wouldCreate: number;
  wouldUpdate: number;
  humanOverrides: number;
  failed: number;
  skipped: boolean;
}

export async function syncHubSpot(client = new HubSpotClient()): Promise<SyncSummary> {
  const summary: SyncSummary = {
    reconciled: 0,
    created: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
    humanOverrides: 0,
    failed: 0,
    skipped: false,
  };

  if (!client.configured) {
    slog.warn('HubSpot token not set — sync skipped (Phase 2 setup pending)');
    summary.skipped = true;
    return summary;
  }

  // Hydrate DOWN first: HubSpot is the system of record, so contacts that exist
  // remotely but not in the local mirror (fresh VPS, or added by Daniel in the
  // HubSpot UI) are pulled in. A pull is a read + local write — allowed in
  // DRY_RUN, which only gates writes to the outside world.
  try {
    const remoteAll = await client.listAllContacts(READ_PROPERTIES);
    let pulled = 0;
    for (const remote of remoteAll) {
      const email = remote.properties.email?.toLowerCase();
      if (!email) continue;
      if (getLeadByEmail(email)) continue;
      const patch = contactToLeadPatch(remote.properties);
      const lead = upsertLead({ ...patch, email, hubspotContactId: remote.id });
      pulled++;
      recordEvent({
        leadId: lead.id,
        type: 'sync.pulled_from_hubspot',
        trigger: 'hubspot-sync',
        reason: `Hydrated from HubSpot contact ${remote.id}`,
      });
      // Score is a pure function of the LOCAL event log — a hydrated lead has
      // state but no history, so recompute would silently zero it. Seed the
      // remote score as an idempotent signal so warmth survives hydration.
      if ((patch.score ?? 0) > 0) {
        applySignal(lead.id, 'warm_start', {
          trigger: 'hubspot-hydration',
          points: patch.score!,
          idempotencyKey: 'seed:hydrated',
          reason: `Hydrated score ${patch.score} from HubSpot`,
        });
      }
    }
    if (pulled > 0) slog.info('hydrated leads from HubSpot', { pulled });
  } catch (err) {
    slog.error('hydration pull failed — continuing with local mirror', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const leads = allLeads();
  slog.info('sync starting', { leads: leads.length, dryRun: config.dryRun });

  for (const lead of leads) {
    try {
      await syncOne(client, lead, summary);
    } catch (err) {
      summary.failed++;
      const message = err instanceof Error ? err.message : String(err);
      slog.error('lead sync failed', { email: lead.email, error: message });
      recordEvent({
        leadId: lead.id,
        type: 'sync.failed',
        trigger: 'hubspot-sync',
        reason: `Sync failed: ${message}`,
      });
      // Continue: one bad record must not abort the batch.
    }
  }

  setSyncState('hubspot.last_sync_at', new Date().toISOString());
  slog.info('sync finished', { ...summary });
  return summary;
}

async function syncOne(client: HubSpotClient, lead: Lead, summary: SyncSummary): Promise<void> {
  {
    const remote = await client.searchContactByEmail(lead.email, READ_PROPERTIES);

    if (remote) {
      const { lead: merged, pushProperties, humanOverrides } = reconcile(lead, remote);
      saveLead(merged);
      summary.reconciled++;
      if (humanOverrides.length > 0) {
        summary.humanOverrides += humanOverrides.length;
        recordEvent({
          leadId: merged.id,
          type: 'sync.human_override',
          trigger: 'hubspot-sync',
          reason: `HubSpot values won for: ${humanOverrides.join(', ')}`,
          data: { fields: humanOverrides },
        });
      }
      if (config.dryRun) {
        summary.wouldUpdate++;
      } else {
        await client.updateContact(remote.id, pushProperties);
      }
    } else {
      if (config.dryRun) {
        summary.wouldCreate++;
        slog.info('[dry-run] would create contact', { email: lead.email });
      } else {
        const created = await client.createContact(leadToContactProperties(lead));
        saveLead({ ...lead, hubspotContactId: created.id, updatedAt: new Date().toISOString() });
        summary.created++;
        recordEvent({
          leadId: lead.id,
          type: 'sync.contact_created',
          trigger: 'hubspot-sync',
          reason: `Created HubSpot contact ${created.id}`,
        });
      }
    }
  }
}
