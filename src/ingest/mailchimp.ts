/**
 * Mailchimp adapter — website registrants who opted in through vedri.studio.
 *
 * Because they opted in, these carry CONSENT (a cleaner PECR basis than cold),
 * so they seed a warm nurture audience rather than a cold sequence.
 *
 * The live pull needs the Mailchimp connector authorised (not yet). The pure
 * member→RawLead mapping and `ingestMailchimpMembers` are testable now and are
 * what the live pull will feed.
 */
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { upsertLead } from '../db/leads.js';
import { normaliseRawLead } from './normalise.js';
import { emptyReport, type ImportReport, type RawLead } from './model.js';

const mlog = log.child('mailchimp');

/** Minimal shape of a Mailchimp list member (subset we use). */
export interface MailchimpMember {
  email_address: string;
  status: string; // 'subscribed' | 'unsubscribed' | 'cleaned' | 'pending'
  merge_fields?: { FNAME?: string; LNAME?: string; COMPANY?: string; [k: string]: unknown };
  timestamp_opt?: string;
}

export function memberToRawLead(m: MailchimpMember): RawLead {
  const mf = m.merge_fields ?? {};
  return {
    email: m.email_address,
    firstName: typeof mf.FNAME === 'string' ? mf.FNAME : undefined,
    lastName: typeof mf.LNAME === 'string' ? mf.LNAME : undefined,
    company: typeof mf.COMPANY === 'string' ? mf.COMPANY : undefined,
    source: 'Mailchimp Signup',
    internalNotes: 'Website opt-in via Mailchimp (consent basis).',
    lastEngagementAt: m.timestamp_opt || undefined,
    provenance: 'Mailchimp website signup',
  };
}

/** Ingest subscribed members. Non-subscribed statuses are respected, not mailed. */
export function ingestMailchimpMembers(members: MailchimpMember[]): ImportReport {
  const report = emptyReport('mailchimp');
  for (const m of members) {
    report.total++;
    if (m.status === 'unsubscribed' || m.status === 'cleaned') {
      // Respect the opt-out: record but do not create a mailable lead.
      report.warnings.push({ reason: `status=${m.status}, not ingested`, email: m.email_address, row: report.total });
      continue;
    }
    const n = normaliseRawLead(memberToRawLead(m));
    if (n.reject || !n.draft) {
      report.rejected.push({ reason: n.reject ?? 'unknown', email: m.email_address, row: report.total });
      continue;
    }
    // Opt-in overrides freemail consent concern — they gave consent.
    const lead = upsertLead({ ...n.draft, needsConsent: false, liaBasis: 'Consent — website opt-in via Mailchimp.' });
    report.imported++;
    report.bySource[lead.source] = (report.bySource[lead.source] ?? 0) + 1;
    recordEvent({
      leadId: lead.id,
      type: 'ingest.mailchimp',
      trigger: 'mailchimp',
      reason: 'Website opt-in imported from Mailchimp',
    });
  }
  return report;
}

/** The datacentre lives in the key's suffix (…-us21). Exported for tests. */
export function dcFromKey(apiKey: string): string | null {
  const dc = apiKey.split('-').pop() ?? '';
  return /^[a-z]{2,4}\d{1,3}$/.test(dc) ? dc : null;
}

async function mcGet(dc: string, apiKey: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`Mailchimp ${res.status} on ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Live pull via the Mailchimp Marketing API. Needs only MAILCHIMP_API_KEY in
 * .env (MAILCHIMP_LIST_ID optionally narrows to one audience; otherwise every
 * audience is pulled). Idempotent: members upsert by email, so re-pulling the
 * whole list each cycle is safe and unsubscribes are respected on every pass.
 */
export async function pullMailchimp(): Promise<ImportReport | null> {
  const apiKey = config.mailchimp.apiKey;
  if (!apiKey) {
    mlog.warn('MAILCHIMP_API_KEY not set — website-signup pull skipped');
    return null;
  }
  const dc = dcFromKey(apiKey);
  if (!dc) {
    mlog.error('MAILCHIMP_API_KEY looks malformed — expected a key ending in a datacentre like -us21');
    return null;
  }

  try {
    let listIds: string[];
    if (config.mailchimp.listId) {
      listIds = [config.mailchimp.listId];
    } else {
      const lists = await mcGet(dc, apiKey, '/lists?count=100&fields=lists.id,lists.name');
      listIds = ((lists.lists as { id: string }[] | undefined) ?? []).map((l) => l.id);
    }

    const members: MailchimpMember[] = [];
    for (const listId of listIds) {
      // Small-studio audiences: page through everything; upserts are idempotent.
      for (let offset = 0; ; offset += 500) {
        const page = await mcGet(
          dc,
          apiKey,
          `/lists/${listId}/members?count=500&offset=${offset}&fields=members.email_address,members.status,members.merge_fields,members.timestamp_opt,total_items`,
        );
        const batch = (page.members as MailchimpMember[] | undefined) ?? [];
        members.push(...batch);
        if (batch.length < 500) break;
      }
    }

    const report = ingestMailchimpMembers(members);
    mlog.info('mailchimp pull complete', { lists: listIds.length, members: members.length, imported: report.imported });
    return report;
  } catch (err) {
    mlog.error('mailchimp pull failed — will retry next cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
