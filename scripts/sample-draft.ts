/**
 * `pnpm run sample-draft <email> [step]` — generate and print one draft for a
 * lead, to preview the voice and check the lint. Does NOT send or save anything.
 */
import { getLeadByEmail } from '../src/db/leads.js';
import { generateDraft, type StepSpec } from '../src/copy/generate.js';
import { selectSequence } from '../src/sequences/load.js';
import { closeDb } from '../src/db/index.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm run sample-draft <email> [step]');
  process.exit(2);
}

const lead = getLeadByEmail(email);
if (!lead) {
  console.error(`No lead for ${email}`);
  closeDb();
  process.exit(1);
}

// Use the lead's real sequence + step definition so the preview matches what
// the engine would actually produce.
const seq = selectSequence(lead);
if (!seq) {
  console.error(`No sequence matches ${email} (track ${lead.track}, source ${lead.source})`);
  closeDb();
  process.exit(1);
}
const stepIndex = Math.min(process.argv[3] ? Number(process.argv[3]) - 1 : 0, seq.steps.length - 1);
const stepDef = seq.steps[stepIndex]!;
const step: StepSpec = {
  sequenceId: seq.id,
  stepIndex,
  purpose: stepDef.purpose,
  guidance: stepDef.guidance,
};

const draft = await generateDraft(lead, step);
closeDb();

console.log(`\n=== Draft for ${lead.firstName ?? ''} at ${lead.company ?? '—'} (${email}) ===`);
console.log(`Track: ${lead.track} · Temperature: ${lead.temperature} (${lead.score})\n`);
console.log('SUBJECT VARIANTS:');
draft.subjects.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
console.log('\nBODY:\n');
console.log(draft.rendered.full);
console.log(`\nLINT: ${draft.lint.pass ? 'PASS ✓' : 'FAIL ✗ — ' + draft.lint.failures.join('; ')}`);
console.log(`(generated in ${draft.attempts} attempt${draft.attempts > 1 ? 's' : ''})\n`);
