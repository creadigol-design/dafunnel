/**
 * Draft a response to a classified reply. Reuses the Phase 5 generator — same
 * voice, same lint gate, same draft-and-approve path — with a step spec built
 * from the reply itself. The response is a DRAFT for Daniel, never auto-sent.
 */
import type { Lead } from '../types.js';
import type { Classification } from './classify.js';
import { generateDraft, type StepSpec } from '../copy/generate.js';
import { persistDraft } from '../mail/draft-store.js';

function specFor(cls: Classification, replyText: string): StepSpec {
  const excerpt = replyText.slice(0, 1200);
  switch (cls.class) {
    case 'POSITIVE_INTERESTED':
      return {
        sequenceId: 'reply-response',
        stepIndex: 0,
        purpose: 'Respond to an interested reply and make booking a call effortless.',
        guidance: `They replied positively: "${cls.summary}". Thank them briefly, answer anything they raised, and offer the booking link as the next step. Their reply: ${excerpt}`,
      };
    case 'QUESTION':
      return {
        sequenceId: 'reply-response',
        stepIndex: 0,
        purpose: 'Answer a specific question helpfully and move toward a call.',
        guidance: `They asked: "${cls.summary}". Answer only from the approved facts — if the answer needs a fact you don't have (price, date, spec), use a {{NEEDS_INPUT: ...}} token so Daniel fills it in. Their reply: ${excerpt}`,
      };
    case 'REFERRAL_REDIRECT':
      return {
        sequenceId: 'reply-response',
        stepIndex: 0,
        purpose: 'Thank the referrer warmly and confirm we will contact their colleague.',
        guidance: `They pointed us at a colleague (${cls.referral?.name ?? cls.referral?.email ?? 'unnamed'}). Thank them genuinely, one line, no pitch. Their reply: ${excerpt}`,
      };
    case 'HARD_NO_REMOVE':
      return {
        sequenceId: 'reply-response',
        stepIndex: 0,
        purpose: 'Politely confirm removal.',
        guidance:
          'Two sentences at most: confirm they are removed and will not hear from us again, no sell, no link, just graceful. No booking link.',
      };
    default:
      return {
        sequenceId: 'reply-response',
        stepIndex: 0,
        purpose: 'Acknowledge their reply.',
        guidance: `Brief, warm acknowledgement. Their reply: ${excerpt}`,
      };
  }
}

/** Generate + persist the response draft (files in DRY_RUN, IMAP Drafts live). */
export async function draftResponse(lead: Lead, cls: Classification, replyText: string): Promise<void> {
  const gen = await generateDraft(lead, specFor(cls, replyText));
  await persistDraft(lead, 'reply-response', 0, 'warm', gen);
}
