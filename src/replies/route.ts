/**
 * Reply routing — deterministic actions per classification.
 *
 * Any reply halts the active sequence (universal rule). Then, by class:
 * - POSITIVE_INTERESTED → +35, urgent alert, response drafted with booking link
 * - QUESTION            → +15, urgent alert, response drafted
 * - POSITIVE_LATER      → halt + dated reminder (resume date), no score bump spam
 * - REFERRAL_REDIRECT   → create the new contact, thank-you draft, alert
 * - NEUTRAL_OOO         → reschedule next touch past the return date, no score
 * - NEGATIVE_NOT_INTERESTED → Nurture (90-day quiet)
 * - HARD_NO_REMOVE      → Suppressed immediately + polite confirmation draft
 * - AUTO_REPLY          → ignore
 * - BOUNCE              → Disqualified
 *
 * Confidence < 0.8 → NO automated action; escalate raw text to Daniel.
 */
import { log } from '../logger.js';
import { recordEvent } from '../db/events.js';
import { getLeadByEmail, saveLead, upsertLead } from '../db/leads.js';
import { applySignal, applyTransition } from '../scoring.js';
import { queueAlert } from '../alerts/queue.js';
import { snapToSendWindow } from '../sequences/schedule.js';
import type { Lead } from '../types.js';
import type { Classification } from './classify.js';

const rlog = log.child('replies');

export const CONFIDENCE_GATE = 0.8;

export interface RouteResult {
  action: string;
  escalated: boolean;
  /** Set when the router wants a response drafted (Phase 5 generator handles it). */
  wantsResponseDraft: boolean;
}

/** Halt whatever sequence the lead is in — any reply stops the machine. */
function haltSequence(lead: Lead, reason: string, asOf: Date): Lead {
  if (lead.sequenceId == null && lead.nextTouchAt == null) return lead;
  const halted: Lead = { ...lead, nextTouchAt: null, updatedAt: asOf.toISOString() };
  saveLead(halted);
  recordEvent({
    leadId: lead.id,
    type: 'sequence.halted',
    trigger: 'reply',
    reason: `Sequence halted: ${reason}`,
  });
  return halted;
}

export function routeReply(
  leadEmail: string,
  cls: Classification,
  replyText: string,
  asOf: Date = new Date(),
): RouteResult {
  const lead = getLeadByEmail(leadEmail);
  if (!lead) {
    rlog.warn('reply from unknown sender', { email: leadEmail });
    queueAlert('needs_input_flagged', {
      payload: { kind: 'unknown_reply_sender', email: leadEmail, summary: cls.summary },
    });
    return { action: 'unknown-sender', escalated: true, wantsResponseDraft: false };
  }

  // Below the gate: no automated action. Raw text goes to Daniel.
  if (cls.confidence < CONFIDENCE_GATE) {
    recordEvent({
      leadId: lead.id,
      type: 'reply.escalated',
      trigger: 'reply-classifier',
      reason: `Low confidence (${cls.confidence.toFixed(2)}) for ${cls.class} — escalated`,
      data: { class: cls.class, confidence: cls.confidence },
    });
    queueAlert('positive_reply', {
      leadId: lead.id,
      payload: { kind: 'low_confidence_escalation', class: cls.class, confidence: cls.confidence, raw: replyText.slice(0, 2000) },
    });
    return { action: 'escalated', escalated: true, wantsResponseDraft: false };
  }

  recordEvent({
    leadId: lead.id,
    type: 'reply.classified',
    trigger: 'reply-classifier',
    reason: `${cls.class} (${cls.confidence.toFixed(2)}): ${cls.summary}`,
    data: { class: cls.class, confidence: cls.confidence },
  });

  switch (cls.class) {
    case 'POSITIVE_INTERESTED': {
      const halted = haltSequence(lead, 'positive reply', asOf);
      applySignal(halted.id, 'reply_positive', { trigger: 'reply', asOf });
      queueAlert('positive_reply', { leadId: halted.id, payload: { summary: cls.summary } });
      return { action: 'positive', escalated: false, wantsResponseDraft: true };
    }
    case 'QUESTION': {
      const halted = haltSequence(lead, 'question received', asOf);
      applySignal(halted.id, 'asked_question', { trigger: 'reply', asOf });
      queueAlert('positive_reply', { leadId: halted.id, payload: { kind: 'question', summary: cls.summary } });
      return { action: 'question', escalated: false, wantsResponseDraft: true };
    }
    case 'POSITIVE_LATER': {
      const halted = haltSequence(lead, `positive-later until ${cls.resumeDate ?? 'unspecified'}`, asOf);
      applySignal(halted.id, 'reply_neutral', { trigger: 'reply', asOf });
      const resume = cls.resumeDate
        ? new Date(`${cls.resumeDate}T09:00:00Z`)
        : new Date(asOf.getTime() + 60 * 86_400_000); // default: 60 days
      saveLead({ ...getLeadByEmail(leadEmail)!, nextTouchAt: snapToSendWindow(resume).toISOString(), updatedAt: asOf.toISOString() });
      queueAlert('band_change', { leadId: halted.id, payload: { kind: 'positive_later', resume: cls.resumeDate } });
      return { action: 'deferred', escalated: false, wantsResponseDraft: false };
    }
    case 'REFERRAL_REDIRECT': {
      const halted = haltSequence(lead, 'referred to colleague', asOf);
      applySignal(halted.id, 'forwarded_cc', { trigger: 'reply', asOf });
      if (cls.referral?.email) {
        const created = upsertLead({
          email: cls.referral.email.toLowerCase(),
          firstName: cls.referral.name,
          company: lead.company,
          companyDomain: lead.companyDomain,
          track: lead.track,
          source: 'Referral',
          liaBasis: `Referred by ${lead.email} in reply to our outreach.`,
        });
        recordEvent({
          leadId: created.id,
          type: 'ingest.referral',
          trigger: 'reply',
          reason: `Referred by ${lead.email}`,
        });
      }
      queueAlert('positive_reply', { leadId: halted.id, payload: { kind: 'referral', to: cls.referral?.email ?? null } });
      return { action: 'referral', escalated: false, wantsResponseDraft: true };
    }
    case 'NEUTRAL_OOO': {
      // Don't score; push the next touch past their return.
      const resume = cls.resumeDate
        ? new Date(`${cls.resumeDate}T09:00:00Z`)
        : new Date(asOf.getTime() + 7 * 86_400_000);
      saveLead({ ...lead, nextTouchAt: snapToSendWindow(resume).toISOString(), updatedAt: asOf.toISOString() });
      recordEvent({ leadId: lead.id, type: 'reply.ooo', trigger: 'reply', reason: `OOO until ${cls.resumeDate ?? 'unknown'} — rescheduled` });
      return { action: 'rescheduled', escalated: false, wantsResponseDraft: false };
    }
    case 'NEGATIVE_NOT_INTERESTED': {
      haltSequence(lead, 'negative reply', asOf);
      applyTransition(lead.id, 'reply_negative', { trigger: 'reply', reason: cls.summary, asOf });
      return { action: 'nurture', escalated: false, wantsResponseDraft: false };
    }
    case 'HARD_NO_REMOVE': {
      haltSequence(lead, 'hard no / removal demand', asOf);
      applyTransition(lead.id, 'hard_no', { trigger: 'reply', reason: cls.summary, asOf });
      return { action: 'suppressed', escalated: false, wantsResponseDraft: true }; // polite confirmation
    }
    case 'AUTO_REPLY':
      return { action: 'ignored', escalated: false, wantsResponseDraft: false };
    case 'BOUNCE': {
      applyTransition(lead.id, 'bounce_hard', { trigger: 'reply', asOf });
      return { action: 'disqualified', escalated: false, wantsResponseDraft: false };
    }
  }
}
