/**
 * Copy lint — the hard gate every generated draft must pass before it can reach
 * Daniel or a prospect. A failing draft goes to the review queue flagged; it is
 * never silently sent.
 *
 * Pure and unit-tested. The internal kit list here is the enforcement of the
 * "never leak the kit" rule — these product/brand names must never appear in
 * client-facing copy, so competitors can't shop vedrí's setup around.
 */

/** Marketing fluff the brand voice bans outright. */
export const BANNED_FLUFF: string[] = [
  'cutting-edge', 'cutting edge', 'revolutionary', 'game-changing', 'game changing',
  'game-changer', 'unlock', 'elevate', 'in today’s fast-paced', "in today's fast-paced",
  'fast-paced landscape', 'world-class', 'best-in-class', 'best in class', 'seamless',
  'synergy', 'paradigm', 'disruptive', 'next level', 'take it to the next level',
  'at the end of the day', 'move the needle', 'circle back', 'bandwidth',
  'cutting through the noise', 'supercharge', 'turbocharge', 'unparalleled',
];

/** American spellings to flag; the brand is British English throughout. */
export const AMERICAN_SPELLINGS: string[] = [
  'color', 'colors', 'colored', 'organize', 'organized', 'organizing', 'organization',
  'realize', 'realized', 'realizing', 'center', 'centered', 'optimize', 'optimized',
  'customize', 'customized', 'maximize', 'minimize', 'apologize', 'favorite', 'catalog',
  'defense', 'offense', 'gray', 'meter', 'meters', 'theater', 'license', 'analyze',
  'prioritize', 'specialize', 'recognize', 'localize', 'behavior', 'behaviors',
  'canceled', 'traveling', 'modeling',
];

/**
 * Internal kit / gear names that must NEVER appear in client-facing copy.
 * Sourced from vedrí's internal kit lists. Client copy uses the vague
 * "what's involved" framing only.
 */
export const INTERNAL_KIT_TERMS: string[] = [
  'assimilate', 'live fx', 'mo-sys', 'mosys', 'startracker', 'star tracker',
  'blackmagic', 'pyxis', 'stype', 'redspy', 'red spy', 'brompton', 'novastar',
  'ndisplay', 'roe', 'bp2v2', 'notch', 'genlock', 'nofrustum',
];

export const MAX_WORDS = 150;
export const MAX_QUESTION_MARKS = 1;

export interface LintInput {
  subject: string;
  /** The message body (without the compliance footer). */
  body: string;
  /** The full rendered message including footer — checked for unsubscribe. */
  rendered: string;
}

export interface LintResult {
  pass: boolean;
  failures: string[];
}

function findAny(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  const hits: string[] = [];
  for (const n of needles) {
    // Word-ish boundary match to avoid false positives inside larger words.
    const re = new RegExp(`(^|[^a-z])${escapeRe(n.toLowerCase())}([^a-z]|$)`, 'i');
    if (re.test(lower)) hits.push(n);
  }
  return hits;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Model-fixable rules (voice, spelling, kit, length, questions, body tokens).
 * A failure here is worth a corrective retry — the model can rewrite it.
 */
export function lintBody(subject: string, body: string): LintResult {
  const failures: string[] = [];
  const text = `${subject}\n${body}`;

  const fluff = findAny(text, BANNED_FLUFF);
  if (fluff.length) failures.push(`banned fluff: ${fluff.join(', ')}`);

  const american = findAny(text, AMERICAN_SPELLINGS);
  if (american.length) failures.push(`American spelling: ${american.join(', ')}`);

  const kit = findAny(text, INTERNAL_KIT_TERMS);
  if (kit.length) failures.push(`internal kit terminology leaked: ${kit.join(', ')}`);

  if (/\{\{\s*NEEDS_INPUT/i.test(text) || /\{\{.*?\}\}/.test(text)) {
    failures.push('unresolved token in body');
  }

  const words = wordCount(body);
  if (words > MAX_WORDS) failures.push(`too long: ${words} words (max ${MAX_WORDS})`);

  const questions = (body.match(/\?/g) ?? []).length;
  if (questions > MAX_QUESTION_MARKS) {
    failures.push(`too many questions: ${questions} (max ${MAX_QUESTION_MARKS})`);
  }

  return { pass: failures.length === 0, failures };
}

/**
 * Config-level rules on the rendered message (unsubscribe present, footer
 * tokens resolved). A failure here needs Daniel/config, not a model rewrite.
 */
export function lintMessage(rendered: string): LintResult {
  const failures: string[] = [];
  if (/\{\{\s*NEEDS_INPUT/i.test(rendered) || /\{\{.*?\}\}/.test(rendered)) {
    failures.push('unresolved NEEDS_INPUT token (e.g. postal address)');
  }
  if (!/unsubscribe/i.test(rendered)) failures.push('missing unsubscribe');
  return { pass: failures.length === 0, failures };
}

/** The full gate: a draft may only send if both body and message pass. */
export function lintDraft(input: LintInput): LintResult {
  const body = lintBody(input.subject, input.body);
  const message = lintMessage(input.rendered);
  const failures = [...body.failures, ...message.failures];
  return { pass: failures.length === 0, failures };
}
