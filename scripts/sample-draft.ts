/**
 * `pnpm run sample-draft <email> [step]` — generate and print one draft for a
 * lead, to preview the voice and check the lint. Does NOT send or save anything.
 */
import { getLeadByEmail } from '../src/db/leads.js';
import { generateDraft, type StepSpec } from '../src/copy/generate.js';
import { closeDb } from '../src/db/index.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm run sample-draft <email>');
  process.exit(2);
}

const lead = getLeadByEmail(email);
if (!lead) {
  console.error(`No lead for ${email}`);
  closeDb();
  process.exit(1);
}

// A3 reactivation, step 1: "lead with what's changed since we last spoke".
const step: StepSpec = {
  sequenceId: 'A3-reactivation',
  stepIndex: 0,
  purpose: 'Reactivate a past conversation by leading with what has changed since we last spoke.',
  guidance:
    'Open by acknowledging we spoke before (use the relationship context). Lead with a concrete capability that is genuinely useful to them now — not "just checking in". One specific, low-friction ask at the end (a short call or a reply).',
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
