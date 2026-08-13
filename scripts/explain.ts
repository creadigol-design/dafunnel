/**
 * `pnpm run explain <email>` — answer "why is this lead hot?"
 *
 * Prints a lead's current state and full, timestamped event history with the
 * running score, so a band or score is never a black box.
 */
import { db, closeDb } from '../src/db/index.js';
import { eventsForLead } from '../src/db/events.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm run explain <email>');
  process.exit(2);
}

const conn = db();
const lead = conn.prepare('SELECT * FROM leads WHERE email = ?').get(email) as
  | Record<string, unknown>
  | undefined;

if (!lead) {
  console.error(`No lead found for ${email}.`);
  closeDb();
  process.exit(1);
}

console.log(`\nvedrí funnel — explain: ${email}\n`);
console.log(`  Name         ${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trimEnd());
console.log(`  Company      ${lead.company ?? '—'}`);
console.log(`  Track        ${lead.track}`);
console.log(`  Source       ${lead.source}`);
console.log(`  Temperature  ${lead.temperature}`);
console.log(`  Score        ${lead.score}`);
console.log(`  ICP fit      ${lead.icp_fit ?? '—'}`);
console.log(`  Sequence     ${lead.sequence_id ?? '—'} (step ${lead.sequence_step ?? '—'})`);
console.log(`  Suppressed   ${lead.suppressed ? 'YES — ' + (lead.suppression_reason ?? '') : 'no'}`);
if (lead.needs_input) console.log(`  Needs input  ${lead.needs_input}`);

const events = eventsForLead(lead.id as string);
console.log(`\n  Event history (${events.length}):\n`);
if (events.length === 0) {
  console.log('    (no events recorded yet)');
} else {
  for (const e of events) {
    const delta =
      e.oldScore != null && e.newScore != null
        ? ` [${e.oldScore} → ${e.newScore}]`
        : '';
    console.log(`    ${e.createdAt}  ${e.type}${delta}`);
    console.log(`      trigger: ${e.trigger} — ${e.reason}`);
  }
}
console.log('');
closeDb();
