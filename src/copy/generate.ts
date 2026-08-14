/**
 * Copy generation — Claude writes each step's subject variants + body, in
 * vedrí's voice, from the client-safe context only. Every draft is rendered with
 * the compliance footer and linted; a lint failure triggers one corrective retry
 * before the draft is flagged for the review queue.
 */
import type { Lead } from '../types.js';
import { complete, extractJson } from '../anthropic.js';
import { buildContext, type CopyContext } from './context.js';
import { renderMessage, type RenderedMessage } from './render.js';
import { lintBody, lintDraft, type LintResult, MAX_WORDS } from './lint.js';

export interface StepSpec {
  sequenceId: string;
  stepIndex: number;
  purpose: string;
  /** Step-specific guidance for what this touch should do. */
  guidance: string;
}

export interface GeneratedDraft {
  subjects: string[];
  body: string;
  rendered: RenderedMessage;
  lint: LintResult;
  attempts: number;
}

const SYSTEM = `You write outreach emails for vedrí, an independent virtual production studio in North Wales led by Daniel Evans. Voice rules — follow every one:

- First person plural ("we", "our"). Technical but warm, like chatting to a fellow creative who has been on set.
- Specific and concrete. Short paragraphs. British English throughout (realised, organised, colour, centre).
- NO marketing fluff. Never: cutting-edge, revolutionary, game-changing, unlock, elevate, world-class, seamless, "in today's fast-paced".
- NEVER name specific gear, camera bodies, tracking systems, LED processors, or software products. Talk about what the shoot gives them ("real-time composited image on the monitors"), never the kit. This is a hard rule.
- Under 150 words in the body. Exactly one question mark, at most. End with one specific, low-friction ask — never "let me know if you're interested".
- Only state facts from the APPROVED FACTS provided. If you need a fact you do not have (a price, a date, a named piece of their work), write a token like {{NEEDS_INPUT: what you need}} instead of inventing it.

Return ONLY JSON: {"subjects": ["variant 1", "variant 2"], "body": "the email body"}. No preamble.`;

function userPrompt(ctx: CopyContext, step: StepSpec): string {
  return [
    `STEP PURPOSE: ${step.purpose}`,
    `GUIDANCE: ${step.guidance}`,
    '',
    `RECIPIENT: ${ctx.firstName}${ctx.company ? ` at ${ctx.company}` : ''}`,
    `TRACK: ${ctx.track === 'VFX' ? 'VFX / post & finishing' : 'Studio / virtual production'}`,
    ctx.recommendedApproach ? `THEIR RECOMMENDED APPROACH: ${ctx.recommendedApproach}` : '',
    ctx.relationship ? `RELATIONSHIP CONTEXT: ${ctx.relationship}` : '',
    '',
    'APPROVED FACTS (the only claims you may make):',
    ...ctx.approvedFacts.map((f) => `- ${f}`),
    '',
    ctx.bookingLink
      ? `CALL-TO-ACTION: if the ask is to talk, point them to the booking link ${ctx.bookingLink} (e.g. "grab a slot that suits: <link>"). Otherwise ask for a short reply.`
      : 'CALL-TO-ACTION: ask for a short reply or a quick call.',
    '',
    'Write two subject-line variants and one body. Keep the body under 150 words.',
  ]
    .filter(Boolean)
    .join('\n');
}

interface RawGen {
  subjects: string[];
  body: string;
}

export async function generateDraft(lead: Lead, step: StepSpec): Promise<GeneratedDraft> {
  const ctx = buildContext(lead);
  let user = userPrompt(ctx, step);
  let made = 0;
  let last: { subjects: string[]; body: string; rendered: RenderedMessage } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    made = attempt;
    const raw = extractJson<RawGen>(await complete({ system: SYSTEM, user, maxTokens: 1024 }));
    const subjects = (raw.subjects ?? []).slice(0, 2);
    const body = (raw.body ?? '').trim();
    const rendered = renderMessage(subjects[0] ?? '', body);
    last = { subjects, body, rendered };
    // Retry only on model-fixable (body) failures; config-level issues (missing
    // postal address, etc.) are flagged for Daniel, not re-generated.
    const body_lint = lintBody(subjects.join(' / '), body);
    if (body_lint.pass) break;
    user = `${user}\n\nYour previous draft FAILED these rules: ${body_lint.failures.join('; ')}. Rewrite to fix every one. Keep the body under ${MAX_WORDS} words.`;
  }

  const lint = lintDraft({ subject: last!.subjects.join(' / '), body: last!.body, rendered: last!.rendered.full });
  return { subjects: last!.subjects, body: last!.body, rendered: last!.rendered, lint, attempts: made };
}
