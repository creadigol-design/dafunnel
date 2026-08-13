/**
 * `pnpm run sync-hubspot` — push the local lead mirror to HubSpot and reconcile.
 *
 * Respects DRY_RUN: with DRY_RUN=true it reports what WOULD sync without writing.
 * To actually write, run with DRY_RUN=false (e.g. `DRY_RUN=false pnpm run sync-hubspot`).
 */
import { config } from '../config/index.js';
import { syncHubSpot } from '../src/hubspot/sync.js';
import { closeDb } from '../src/db/index.js';

const s = await syncHubSpot();
closeDb();

console.log('\nHubSpot sync' + (config.dryRun ? ' (DRY RUN — no writes)' : '') + '\n');
if (s.skipped) {
  console.log('  skipped — HUBSPOT_PRIVATE_APP_TOKEN not set');
} else {
  console.log(`  created         ${s.created}`);
  console.log(`  reconciled      ${s.reconciled}`);
  console.log(`  would create    ${s.wouldCreate}`);
  console.log(`  would update    ${s.wouldUpdate}`);
  console.log(`  human overrides ${s.humanOverrides}`);
  console.log(`  failed          ${s.failed}`);
}
console.log('');
process.exit(s.failed > 0 ? 1 : 0);
