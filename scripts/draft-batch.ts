/**
 * `pnpm run draft-batch [limit]` — run the sequence engine once for up to
 * `limit` due leads (default 3) and list the drafts produced. In DRY_RUN the
 * drafts are written to output/drafts/ as files to review.
 */
import { runSequences } from '../src/sequences/engine.js';
import { closeDb } from '../src/db/index.js';

const limit = process.argv[2] ? Number(process.argv[2]) : 3;
const s = await runSequences(new Date(), { limit });
closeDb();

console.log(`\nSequence run — processed ${s.processed}, drafts ready ${s.generated}, lint-flagged ${s.lintFailed}`);
console.log('Drafts written to output/drafts/ (shadow mode).\n');
