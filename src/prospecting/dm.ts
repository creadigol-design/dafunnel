/**
 * Instagram DM assist — the system writes a short DM in Daniel's voice and
 * tracks the conversation state; Daniel's own thumb does every send. DM
 * automation (bots, unofficial APIs) gets Instagram accounts banned, so the
 * boundary is hard: we draft, deep-link to the thread, remember, and nudge.
 *
 * DMs are held to the same hard rules as email: no internal kit terms, no
 * marketing fluff, British English — plus a much tighter word cap, because a
 * three-paragraph DM from a stranger is spam however good the words are.
 */
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { recordEvent } from '../db/events.js';
import { queueAlert } from '../alerts/queue.js';
import { complete, extractJson } from '../anthropic.js';
import { BANNED_FLUFF, AMERICAN_SPELLINGS, INTERNAL_KIT_TERMS } from '../copy/lint.js';

const dlog = log.child('ig-dm');

export const DM_MAX_WORDS = 60;
/** Days of silence before a sent DM becomes due for a follow-up. */
export const DM_FOLLOW_UP_DAYS = 4;
/** Hard cap on sends per prospect: one intro + one follow-up, then stop. */
export const DM_MAX_SENDS = 2;

export interface DmLintResult {
  pass: boolean;
  failures: string[];
}

function findAny(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((n) => lower.includes(n));
}

/** Hard gate for a DM. Kit terms block absolutely, same as email. */
export function lintDm(text: string): DmLintResult {
  const failures: string[] = [];
  const kit = findAny(text, INTERNAL_KIT_TERMS);
  if (kit.length) failures.push(`internal kit terms: ${kit.join(', ')}`);
  const fluff = findAny(text, BANNED_FLUFF);
  if (fluff.length) failures.push(`banned fluff: ${fluff.join(', ')}`);
  const american = AMERICAN_SPELLINGS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  if (american.length) failures.push(`American spellings: ${american.join(', ')}`);
  const words = text.trim().split(/\s+/).length;
  if (words > DM_MAX_WORDS) failures.push(`too long: ${words} words (max ${DM_MAX_WORDS} for a DM)`);
  if ((text.match(/\?/g) ?? []).length > 1) failures.push('more than one question');
  if (/https?:\/\//i.test(text)) failures.push('no links in a first DM — it reads as spam');
  return { pass: failures.length === 0, failures };
}

/** Pull the handle out of an instagram-origin prospect's evidence URL. */
export function igHandle(evidenceUrl: string): string | null {
  const m = evidenceUrl.match(/instagram\.com\/([a-z0-9._]{1,30})/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** Normalise any published handle form (@x, instagram.com/x, x) — or null. */
export function normaliseIgHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

const SYSTEM = `You write short Instagram DMs for vedrí (@vedri.studio), an independent virtual production studio in North Wales run by Daniel Evans.

Rules — all hard:
- ONLY mention them following/liking/engaging with vedrí if the context explicitly says they did. Claiming engagement that never happened is instantly detectable and fatal — they can see their own history.
- Under ${DM_MAX_WORDS} words. A DM is a text message, not an email. No greeting-name formality ("Hi there," is fine; no "Dear").
- Warm, casual, specific. Sounds like a person on their phone, not a brand. British English.
- NEVER name gear, software or tracking systems. Talk about what a shoot looks like, never the kit.
- No marketing fluff (cutting-edge, elevate, unlock, seamless...). No links. At most one question.
- NEVER invent facts about them or claim a conversation that never happened. "Thanks for the follow" / "saw you liked one of our posts" is as far as the assumed history goes.
- One clear thought: who we are in half a sentence, why they seem interesting, one easy question.

Return ONLY JSON: {"dm": "the message"}. No preamble.`;

export interface DmProspect {
  id: string;
  company: string;
  category: string | null;
  location: string | null;
  why_fit: string | null;
  contact_name: string | null;
  track: string;
  /** 'instagram' = they engaged with vedri.studio; anything else = cold. */
  origin: string;
}

export async function generateDm(p: DmProspect, kind: 'intro' | 'follow_up'): Promise<string> {
  const who = [
    `Account/company: ${p.company}`,
    p.category ? `What they are: ${p.category}` : '',
    p.location ? `Where: ${p.location}` : '',
    p.why_fit ? `What we know (from public research): ${p.why_fit}` : '',
    p.contact_name ? `Likely person behind it: ${p.contact_name.split(/\s+/)[0]}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const engaged = p.origin === 'instagram';
  const ask =
    kind === 'intro'
      ? engaged
        ? 'They engaged with vedri.studio on Instagram (a follow, like or comment). Write the FIRST DM: light thanks for the engagement, half a sentence on what we do, one genuine question about their work.'
        : 'COLD first DM — they have NOT interacted with us on Instagram; never imply a follow, like or prior contact. Open with something specific and genuine about their work (use what we know), half a sentence on who we are, one easy question.'
      : 'Write a FOLLOW-UP DM (they did not reply to the first one, sent days ago). Do NOT guilt or "just checking in" — offer one new, specific thought or genuinely useful angle, and make it effortless to ignore or answer.';

  let user = `${who}\n\n${ask}`;
  let text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = extractJson<{ dm?: string }>(await complete({ system: SYSTEM, user, maxTokens: 300 }));
    text = (raw.dm ?? '').trim();
    const lint = lintDm(text);
    if (lint.pass) return text;
    if (attempt === 1) {
      user = `${user}\n\nYour previous DM FAILED these rules: ${lint.failures.join('; ')}. Rewrite to fix every one.`;
    } else {
      // Two failures → refuse rather than hand Daniel something rule-breaking.
      throw new Error(`DM failed lint twice: ${lint.failures.join('; ')}`);
    }
  }
  return text;
}

export interface DmSweepSummary {
  due: number;
}

/**
 * Hourly sweep: a sent DM with DM_FOLLOW_UP_DAYS of silence (and sends left)
 * becomes follow_up_due with a drafted follow-up ready in the portal, and
 * Daniel gets a batched Slack nudge. At the send cap it quietly becomes
 * 'done' — nobody gets pestered forever.
 */
export async function sweepDueDms(asOf: Date = new Date()): Promise<DmSweepSummary> {
  const summary: DmSweepSummary = { due: 0 };
  const cutoff = new Date(asOf.getTime() - DM_FOLLOW_UP_DAYS * 86_400_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT id, company, category, location, why_fit, contact_name, track, origin, ig_dm_count FROM prospects
       WHERE ig_dm_status = 'sent' AND ig_dm_sent_at <= ?`,
    )
    .all(cutoff) as (DmProspect & { ig_dm_count: number })[];

  for (const p of rows) {
    const now = asOf.toISOString();
    if (p.ig_dm_count >= DM_MAX_SENDS) {
      db().prepare("UPDATE prospects SET ig_dm_status = 'done', updated_at = ? WHERE id = ?").run(now, p.id);
      recordEvent({
        type: 'prospect.dm',
        trigger: 'dm-sweep',
        reason: `${p.company}: no reply after ${p.ig_dm_count} DMs — leaving them be.`,
        data: { prospectId: p.id, status: 'done' },
      });
      continue;
    }
    if (!config.anthropic.apiKey) continue; // cap-flips above still apply
    let followUp: string;
    try {
      followUp = await generateDm(p, 'follow_up');
    } catch (err) {
      dlog.warn('follow-up draft failed — will retry next sweep', {
        company: p.company,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    db()
      .prepare("UPDATE prospects SET ig_dm = ?, ig_dm_status = 'follow_up_due', updated_at = ? WHERE id = ?")
      .run(followUp, now, p.id);
    recordEvent({
      type: 'prospect.dm',
      trigger: 'dm-sweep',
      reason: `${p.company}: ${DM_FOLLOW_UP_DAYS} days of silence — follow-up DM drafted for review.`,
      data: { prospectId: p.id, status: 'follow_up_due' },
    });
    summary.due++;
  }

  if (summary.due > 0) {
    queueAlert('ig_dm_followup', {
      payload: { due: summary.due, note: 'Instagram follow-up DMs drafted — portal /prospects.' },
    });
  }
  return summary;
}
