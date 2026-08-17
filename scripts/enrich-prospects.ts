/**
 * `pnpm run enrich` — look up the best person to contact (and their published
 * email) for queued prospect candidates that have not been enriched yet.
 * Runs automatically after every discovery pass; this command backfills
 * candidates that were queued before enrichment existed, or retries failures.
 */
import { enrichCandidates } from '../src/prospecting/enrich.js';
import { closeDb } from '../src/db/index.js';

const s = await enrichCandidates(20);
closeDb();

if (s.looked === 0) {
  console.log('Nothing to enrich — every queued candidate has been looked up already.');
} else {
  console.log(
    `\nEnrichment — looked up ${s.looked} companies: ${s.withEmail} with a published email, ` +
      `${s.withName} with a named person, ${s.nothingFound} with nothing published.`,
  );
  console.log('Contacts now show on the portal /prospects page.\n');
}
