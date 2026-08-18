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
- These are personal notes, not pitches. Write like Daniel dropping a short line to someone he knows professionally: ONE thought per email, conversational, no capability lists. Use at most ONE approved fact per email — and only when it directly serves the thought; using none is often better. Stacking facts turns a note into a brochure, and brochures get deleted.
- Specific and concrete. Short paragraphs. British English throughout (realised, organised, colour, centre).
- NO marketing fluff. Never: cutting-edge, revolutionary, game-changing, unlock, elevate, world-class, seamless, "in today's fast-paced".
- NEVER name specific gear, camera bodies, tracking systems, LED processors, or software products. Talk about what the shoot gives them ("real-time composited image on the monitors"), never the kit. This is a hard rule.
- Under 150 words in the body. Exactly one question mark, at most. End with one specific, low-friction ask — never "let me know if you're interested".
- Only state facts from the APPROVED FACTS provided. If you need a fact you do not have (a price, a date, a named piece of their work), write a token like {{NEEDS_INPUT: what you need}} instead of inventing it.
- NEVER invent relationship history. Only reference a past call, chat or meeting if the RELATIONSHIP CONTEXT explicitly includes one (e.g. a "Discovery" or "Negotiating" stage). If the context says the relationship was only an initial reach-out — or there is no relationship context — open as a re-introduction ("we got in touch a while back about…"), not a reunion ("good to reconnect", "since we last spoke"). Claiming a conversation that never happened destroys trust instantly.

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
    ctx.research
      ? `WHAT WE KNOW ABOUT THEM (public research — reference their work naturally, never cite sources or sound like you have a file on them): ${ctx.research}`
      : '',
    '',
    'APPROVED FACTS (the ONLY claims you may make — pick at most ONE, or none; never several):',
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

export interface RewriteSpec {
  /** Daniel's steer: what this email should say. */
  instruction: string;
  currentSubject: string;
  currentBody: string;
}

/**
 * Prompt for a Daniel-steered rewrite. His instruction outranks the original
 * draft and counts as approved fact — he knows the relationship and the
 * prospect better than the record does. The hard rules (no gear names, no
 * fluff, footer, length) still apply; the lint enforces them regardless.
 * Exported for tests.
 */
export function buildRewritePrompt(ctx: CopyContext, spec: RewriteSpec): string {
  return [
    'Daniel has reviewed the draft below and given a DIRECT INSTRUCTION for what this email should say. Rewrite it following his instruction faithfully — it outranks the original draft. Anything Daniel states in his instruction counts as an approved fact: he knows things the record does not (real conversations, their recent work, context from Instagram or a call). Everything NOT from his instruction still follows the standard rules: approved facts only, {{NEEDS_INPUT}} tokens for facts you lack, never invent relationship history beyond what he or the context states.',
    '',
    `DANIEL'S INSTRUCTION: ${spec.instruction}`,
    '',
    `CURRENT DRAFT SUBJECT: ${spec.currentSubject}`,
    'CURRENT DRAFT BODY:',
    spec.currentBody,
    '',
    `RECIPIENT: ${ctx.firstName}${ctx.company ? ` at ${ctx.company}` : ''}`,
    `TRACK: ${ctx.track === 'VFX' ? 'VFX / post & finishing' : 'Studio / virtual production'}`,
    ctx.relationship ? `RELATIONSHIP CONTEXT (per the record): ${ctx.relationship}` : '',
    ctx.research
      ? `WHAT WE KNOW ABOUT THEM (public research — reference naturally, never cite sources): ${ctx.research}`
      : '',
    '',
    'APPROVED FACTS (besides what Daniel just told you):',
    ...ctx.approvedFacts.map((f) => `- ${f}`),
    '',
    ctx.bookingLink
      ? `CALL-TO-ACTION: if the ask is to talk, the booking link is ${ctx.bookingLink} — but only use it if it fits Daniel's instruction.`
      : '',
    '',
    'Write two subject-line variants and one body. Keep the body under 150 words unless his instruction demands otherwise — and even then, shorter is better.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Rewrite a draft to Daniel's steer, with the usual lint + one retry. */
export async function rewriteDraft(lead: Lead, spec: RewriteSpec): Promise<GeneratedDraft> {
  const ctx = buildContext(lead);
  let user = buildRewritePrompt(ctx, spec);
  let made = 0;
  let last: { subjects: string[]; body: string; rendered: RenderedMessage } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    made = attempt;
    let raw: RawGen;
    try {
      raw = extractJson<RawGen>(await complete({ system: SYSTEM, user, maxTokens: 1024 }));
    } catch (err) {
      if (attempt === 2) throw err;
      user = `${user}\n\nYour previous response was not valid JSON. Return ONLY the JSON object, nothing else.`;
      continue;
    }
    const subjects = (raw.subjects ?? []).slice(0, 2);
    const body = (raw.body ?? '').trim();
    const rendered = renderMessage(subjects[0] ?? '', body);
    last = { subjects, body, rendered };
    const body_lint = lintBody(subjects.join(' / '), body);
    if (body_lint.pass) break;
    user = `${user}\n\nYour previous rewrite FAILED these rules: ${body_lint.failures.join('; ')}. Rewrite to fix every one while still following Daniel's instruction. Keep the body under ${MAX_WORDS} words.`;
  }
  if (!last) throw new Error('rewrite produced no usable draft');

  const lint = lintDraft({ subject: last!.subjects.join(' / '), body: last!.body, rendered: last!.rendered.full });
  return { subjects: last!.subjects, body: last!.body, rendered: last!.rendered, lint, attempts: made };
}

export async function generateDraft(lead: Lead, step: StepSpec): Promise<GeneratedDraft> {
  const ctx = buildContext(lead);
  let user = userPrompt(ctx, step);
  let made = 0;
  let last: { subjects: string[]; body: string; rendered: RenderedMessage } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    made = attempt;
    let raw: RawGen;
    try {
      raw = extractJson<RawGen>(await complete({ system: SYSTEM, user, maxTokens: 1024 }));
    } catch (err) {
      // Empty/garbled response — transient. One retry with a nudge; a second
      // failure propagates so nothing half-parsed is ever saved.
      if (attempt === 2) throw err;
      user = `${user}\n\nYour previous response was not valid JSON. Return ONLY the JSON object, nothing else.`;
      continue;
    }
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
  if (!last) throw new Error('generation produced no usable draft');

  const lint = lintDraft({ subject: last!.subjects.join(' / '), body: last!.body, rendered: last!.rendered.full });
  return { subjects: last!.subjects, body: last!.body, rendered: last!.rendered, lint, attempts: made };
}
