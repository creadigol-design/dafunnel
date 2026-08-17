/**
 * `pnpm run prospect` — force a prospecting run now (ignores the weekly gate).
 * Candidates land in the prospects table and are reviewed in the portal under
 * /prospects. Nothing is contacted until a candidate is approved there.
 */
import { runProspector } from '../src/prospecting/discover.js';
import { closeDb } from '../src/db/index.js';

const s = await runProspector(new Date(), true);
closeDb();

if (s.skippedReason) {
  console.log(`Prospector skipped: ${s.skippedReason}`);
  process.exit(1);
}
console.log(
  `\nProspecting run — model surfaced ${s.found}, queued ${s.queued} new candidate(s), ` +
    `${s.duplicates} already known, ${s.dropped} dropped (no evidence).`,
);
console.log('Review them in the portal under /prospects.\n');
