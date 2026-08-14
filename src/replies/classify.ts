/**
 * Reply classification — Claude sorts each inbound reply into one of nine
 * classes with a confidence score.
 *
 * The 0.8 confidence gate is enforced by the router, not here: below it, NO
 * automated action is taken and the raw text is escalated to Daniel. Getting a
 * reply wrong in the confident direction is worse than asking.
 */
import { complete, extractJson } from '../anthropic.js';
import type { ReplyClass } from '../types.js';

export interface Classification {
  class: ReplyClass;
  confidence: number;
  /** For POSITIVE_LATER / OOO: the date they named, ISO YYYY-MM-DD, if any. */
  resumeDate: string | null;
  /** For REFERRAL_REDIRECT: the colleague's email/name if present. */
  referral: { email: string | null; name: string | null } | null;
  /** One-line summary for the alert. */
  summary: string;
}

export const REPLY_CLASSES: ReplyClass[] = [
  'POSITIVE_INTERESTED',
  'POSITIVE_LATER',
  'QUESTION',
  'REFERRAL_REDIRECT',
  'NEUTRAL_OOO',
  'NEGATIVE_NOT_INTERESTED',
  'HARD_NO_REMOVE',
  'AUTO_REPLY',
  'BOUNCE',
];

const SYSTEM = `You classify email replies received by vedrí, a virtual production studio, in response to its outreach. Classify the reply into exactly one of:

- POSITIVE_INTERESTED: wants to talk, book, or proceed now
- POSITIVE_LATER: interested but names a later time ("come back in September")
- QUESTION: asks something specific (kit, dates, process, price) without committing
- REFERRAL_REDIRECT: points us at a colleague or different contact
- NEUTRAL_OOO: out-of-office auto-response with a return date
- NEGATIVE_NOT_INTERESTED: polite/plain "not for us, not now" — but NOT a removal demand
- HARD_NO_REMOVE: demands removal, unsubscribe, "stop emailing me", legal threat
- AUTO_REPLY: automated non-OOO response (ticket systems, "we received your email")
- BOUNCE: delivery failure notification

Be conservative: if a reply is ambiguous between a positive and negative reading, lower your confidence rather than guessing. A removal demand ALWAYS wins over any other signal in the message.

Return ONLY JSON:
{"class": "...", "confidence": 0.0-1.0, "resumeDate": "YYYY-MM-DD or null", "referral": {"email": "... or null", "name": "... or null"} or null, "summary": "one line"}`;

export async function classifyReply(replyText: string): Promise<Classification> {
  const raw = extractJson<Classification>(
    await complete({
      system: SYSTEM,
      user: `Classify this reply:\n\n---\n${replyText.slice(0, 4000)}\n---`,
      maxTokens: 400,
    }),
  );
  // Defensive normalisation — never trust the model's shape blindly.
  const cls = REPLY_CLASSES.includes(raw.class) ? raw.class : 'QUESTION';
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  return {
    class: cls,
    confidence,
    resumeDate: raw.resumeDate ?? null,
    referral: raw.referral ?? null,
    summary: raw.summary ?? '(no summary)',
  };
}
