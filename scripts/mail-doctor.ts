/**
 * `pnpm run mail-doctor` — verify the cPanel mailbox connection (IMAP + SMTP)
 * and that the Drafts folder exists. Run this after putting MAIL_PASS in .env.
 */
import { config } from '../config/index.js';
import { testConnection } from '../src/mail/client.js';

if (!config.mail.pass) {
  console.error('\nMAIL_PASS is not set in .env — add the info@vedri.studio mailbox password.\n');
  process.exit(2);
}

console.log(`\nmail-doctor — ${config.mail.user} @ ${config.mail.host}\n`);
const r = await testConnection();
console.log(`  IMAP (${config.mail.imapPort})   ${r.imap ? '✓ connected' : '✗ failed'}`);
console.log(`  Drafts folder    ${r.drafts ? `✓ ${config.mail.draftsFolder}` : `✗ "${config.mail.draftsFolder}" not found`}`);
console.log(`  SMTP (${config.mail.smtpPort})    ${r.smtp ? '✓ verified' : '✗ failed'}`);
if (r.error) console.log(`\n  error: ${r.error}`);
if (!r.drafts && r.imap) console.log('\n  (Drafts folder name differs on your host — set MAIL_DRAFTS_FOLDER in .env.)');
console.log('');
process.exit(r.imap && r.smtp ? 0 : 1);
