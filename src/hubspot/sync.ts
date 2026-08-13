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
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { setSyncState } from '../db/index.js';
import { allLeads, saveLead } from '../db/leads.js';
import { HubSpotClient } from './client.js';
import { leadToContactProperties, HUMAN_OWNED_FIELDS, MACHINE_OWNED_FIELDS } from './mapping.js';
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
  skipped: boolean;
}

export async function syncHubSpot(client = new HubSpotClient()): Promise<SyncSummary> {
  const summary: SyncSummary = {
    reconciled: 0,
    created: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
    humanOverrides: 0,
    skipped: false,
  };

  if (!client.configured) {
    slog.warn('HubSpot token not set — sync skipped (Phase 2 setup pending)');
    summary.skipped = true;
    return summary;
  }

  const leads = allLeads();
  slog.info('sync starting', { leads: leads.length, dryRun: config.dryRun });

  for (const lead of leads) {
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

  setSyncState('hubspot.last_sync_at', new Date().toISOString());
  slog.info('sync finished', { ...summary });
  return summary;
}
