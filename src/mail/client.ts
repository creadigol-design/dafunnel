/**
 * cPanel mail transport — IMAP (read + draft) and SMTP (send).
 *
 * Draft-and-approve on cPanel: we build the RFC822 message and APPEND it to the
 * mailbox's Drafts folder over IMAP, so it appears in Daniel's webmail/mail
 * client Drafts for him to review and send by hand. SMTP send is only used once
 * AUTO_SEND_FOLLOWUPS is switched on.
 *
 * Network note: IMAP/SMTP are raw TLS (993/465), not HTTPS — a sandbox that only
 * allows HTTPS-via-proxy may block these; the deployed runner will not.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config, requireSecret } from '../../config/index.js';
import { log } from '../logger.js';

const mlog = log.child('mail');

function fromHeader(): string {
  return `${config.mail.fromName} <${config.mail.user}>`;
}

/** Build a raw RFC822 message (used for both drafts and sends). */
export function buildMime(to: string, subject: string, text: string): Promise<Buffer> {
  const composer = new MailComposer({ from: fromHeader(), to, subject, text });
  return composer.compile().build();
}

function imapClient(): ImapFlow {
  return new ImapFlow({
    host: config.mail.host,
    port: config.mail.imapPort,
    secure: true,
    auth: { user: config.mail.user, pass: requireSecret(config.mail.pass, 'MAIL_PASS') },
    logger: false,
  });
}

/** Append a message to the Drafts folder for human review. Returns the UID if known. */
export async function saveDraftToMailbox(to: string, subject: string, text: string): Promise<void> {
  const raw = await buildMime(to, subject, text);
  const client = imapClient();
  await client.connect();
  try {
    await client.append(config.mail.draftsFolder, raw, ['\\Draft']);
    mlog.info('draft saved to mailbox', { to, folder: config.mail.draftsFolder });
  } finally {
    await client.logout();
  }
}

/** Send a message over SMTP (only when auto-send is on). */
export async function sendMail(to: string, subject: string, text: string): Promise<string> {
  const transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.smtpPort,
    secure: true,
    auth: { user: config.mail.user, pass: requireSecret(config.mail.pass, 'MAIL_PASS') },
  });
  const info = await transporter.sendMail({ from: fromHeader(), to, subject, text });
  mlog.info('mail sent', { to, messageId: info.messageId });
  return info.messageId;
}

/** Verify IMAP + SMTP auth. Used by mail-doctor. */
export async function testConnection(): Promise<{ imap: boolean; smtp: boolean; drafts: boolean; error?: string }> {
  const result = { imap: false, smtp: false, drafts: false, error: undefined as string | undefined };
  try {
    const client = imapClient();
    await client.connect();
    result.imap = true;
    const mailboxes = await client.list();
    result.drafts = mailboxes.some((m) => m.path === config.mail.draftsFolder);
    await client.logout();
  } catch (err) {
    result.error = `IMAP: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.smtpPort,
      secure: true,
      auth: { user: config.mail.user, pass: config.mail.pass },
    });
    await transporter.verify();
    result.smtp = true;
  } catch (err) {
    result.error = `SMTP: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}
