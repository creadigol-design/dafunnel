/**
 * Reply polling — read new mail from the cPanel inbox over IMAP and feed it to
 * the right pipeline:
 *
 * - FormSubmit notifications → inbound lead ingestion (highest-value leads)
 * - Known-lead senders       → classify + route + (maybe) draft a response
 * - Our own sends            → skipped
 * - Unknown senders          → flagged to Daniel, untouched
 *
 * Idempotency: we track the last processed IMAP UID in sync_state rather than
 * flagging messages \Seen — Daniel reads this mailbox too, and his read state is
 * his own. Nothing is ever deleted or moved.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config, requireSecret } from '../../config/index.js';
import { log } from '../logger.js';
import { getSyncState, setSyncState } from '../db/index.js';
import { getLeadByEmail } from '../db/leads.js';
import { ingestInboundBodies } from '../ingest/inbound.js';
import { classifyReply } from './classify.js';
import { routeReply } from './route.js';
import { draftResponse } from './respond.js';

const plog = log.child('reply-poll');

const FORM_SENDERS = new Set(['submissions@formsubmit.co']);

export interface InboundMessage {
  from: string;
  subject: string;
  text: string;
  receivedAt: string;
}

export interface PollSummary {
  fetched: number;
  inboundForms: number;
  repliesRouted: number;
  responsesDrafted: number;
  unknown: number;
  skipped: boolean;
}

/** Process one parsed message. Exported for tests — no IMAP needed. */
export async function processMessage(msg: InboundMessage, summary: PollSummary): Promise<void> {
  const from = msg.from.toLowerCase();

  if (from === config.mail.user.toLowerCase()) return; // our own mail

  if (FORM_SENDERS.has(from)) {
    ingestInboundBodies([{ body: msg.text, receivedAt: msg.receivedAt }]);
    summary.inboundForms++;
    return;
  }

  const lead = getLeadByEmail(from);
  if (!lead) {
    // Unknown sender — flag for Daniel, take no action.
    routeReply(from, { class: 'QUESTION', confidence: 0, resumeDate: null, referral: null, summary: msg.subject }, msg.text);
    summary.unknown++;
    return;
  }

  const cls = await classifyReply(msg.text);
  const result = routeReply(from, cls, msg.text);
  summary.repliesRouted++;
  if (result.wantsResponseDraft && !result.escalated) {
    await draftResponse(lead, cls, msg.text);
    summary.responsesDrafted++;
  }
}

export async function pollReplies(): Promise<PollSummary> {
  const summary: PollSummary = {
    fetched: 0,
    inboundForms: 0,
    repliesRouted: 0,
    responsesDrafted: 0,
    unknown: 0,
    skipped: false,
  };

  if (!config.mail.pass) {
    plog.warn('MAIL_PASS not set — reply polling skipped');
    summary.skipped = true;
    return summary;
  }

  const client = new ImapFlow({
    host: config.mail.host,
    port: config.mail.imapPort,
    secure: true,
    auth: { user: config.mail.user, pass: requireSecret(config.mail.pass, 'MAIL_PASS') },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    plog.error('IMAP connect failed — polling skipped this cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
    summary.skipped = true;
    return summary;
  }

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const lastUid = Number(getSyncState('mail.inbox.last_uid') ?? '0');
      let maxUid = lastUid;

      for await (const msg of client.fetch(
        { uid: `${lastUid + 1}:*` },
        { uid: true, source: true, internalDate: true },
      )) {
        if (msg.uid <= lastUid) continue; // IMAP ranges can echo the last UID
        summary.fetched++;
        maxUid = Math.max(maxUid, msg.uid);
        try {
          const parsed = await simpleParser(msg.source!);
          await processMessage(
            {
              from: parsed.from?.value[0]?.address ?? '',
              subject: parsed.subject ?? '',
              text: parsed.text ?? '',
              receivedAt: new Date(msg.internalDate ?? Date.now()).toISOString(),
            },
            summary,
          );
        } catch (err) {
          plog.error('message processing failed — will not retry this UID', {
            uid: msg.uid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (maxUid > lastUid) setSyncState('mail.inbox.last_uid', String(maxUid));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  plog.info('reply poll complete', { ...summary });
  return summary;
}
