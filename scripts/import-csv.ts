/**
 * `pnpm run import-csv <path> [profile]` — import a lead CSV and print the
 * validation report. Profile defaults to `vedri-crm`; use `built-list` for
 * purchased/built prospect lists.
 */
import { importCsv, PROFILES } from '../src/ingest/csv-import.js';
import { closeDb } from '../src/db/index.js';

const path = process.argv[2];
const profile = process.argv[3] ?? 'vedri-crm';

if (!path) {
  console.error(`Usage: pnpm run import-csv <path> [profile]\nProfiles: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}

const r = importCsv(path, profile);
closeDb();

console.log(`\nImport report — ${r.file}\n  profile: ${r.source}\n`);
console.log(`  rows total          ${r.total}`);
console.log(`  imported            ${r.imported}`);
console.log(`  duplicates in file  ${r.duplicatesInFile}`);
console.log(`  rejected            ${r.rejected.length}`);
console.log(`  warnings            ${r.warnings.length}`);
console.log(`  role inboxes        ${r.roleAccounts.length}`);
console.log(`  needs consent       ${r.needsConsent.length}`);
console.log(`\n  by source:`);
for (const [k, v] of Object.entries(r.bySource)) console.log(`    ${k.padEnd(16)} ${v}`);

if (r.rejected.length) {
  console.log(`\n  rejected rows:`);
  for (const x of r.rejected) console.log(`    row ${x.row}: ${x.reason}${x.email ? ` (${x.email})` : ''}`);
}
if (r.needsConsent.length) {
  console.log(`\n  needs consent (freemail/individual — do not cold-mail):`);
  for (const e of r.needsConsent) console.log(`    ${e}`);
}
if (r.roleAccounts.length) {
  console.log(`\n  role inboxes (lower priority):`);
  for (const e of r.roleAccounts) console.log(`    ${e}`);
}
console.log('');
