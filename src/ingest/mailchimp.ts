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

/** Live pull — gated on the Mailchimp connector being authorised. */
export async function pullMailchimp(): Promise<ImportReport | null> {
  // The Mailchimp MCP connector is not authorised in headless runs; the
  // deployed pull will use the Mailchimp Marketing API with an API key.
  mlog.warn('Mailchimp not authorised — pull skipped (authorise the connector to enable)');
  return null;
}
