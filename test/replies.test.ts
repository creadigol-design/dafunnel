/**
 * Reply-routing tests. The router is where a wrong move costs real money
 * (mailing someone who said stop) or real revenue (dropping a hot reply), so
 * every class's actions are pinned. No API calls — classifications are fixtures.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vedri-replies-'));
process.env.DB_PATH = join(tmp, 'replies.db');
process.env.LOG_DIR = join(tmp, 'logs');
process.env.HUBSPOT_PRIVATE_APP_TOKEN = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, closeDb } = await import('../src/db/index.js');
const { upsertLead, getLeadByEmail } = await import('../src/db/leads.js');
const { applySignal } = await import('../src/scoring.js');
const { routeReply, CONFIDENCE_GATE } = await import('../src/replies/route.js');
import type { Classification } from '../src/replies/classify.js';

const T0 = new Date('2026-08-04T09:00:00.000Z'); // a Tuesday

function cls(c: Classification['class'], patch: Partial<Classification> = {}): Classification {
  return { class: c, confidence: 0.95, resumeDate: null, referral: null, summary: 'test', ...patch };
}

let n = 0;
function lead(patch: Record<string, unknown> = {}): string {
  const email = `r${n++}@prodco.co.uk`;
  upsertLead({ email, sequenceId: 'A3-reactivation', sequenceStep: 1, nextTouchAt: '2026-09-01T08:00:00Z', ...patch });
  return email;
}

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('universal rules', () => {
  it('any actionable reply halts the sequence', () => {
    const email = lead();
    routeReply(email, cls('POSITIVE_INTERESTED'), 'yes please', T0);
    expect(getLeadByEmail(email)!.nextTouchAt).toBeNull();
  });

  it(`confidence below ${CONFIDENCE_GATE} takes no action and escalates`, () => {
    const email = lead();
    const before = getLeadByEmail(email)!;
    const r = routeReply(email, cls('HARD_NO_REMOVE', { confidence: 0.5 }), 'ambiguous', T0);
    const after = getLeadByEmail(email)!;
    expect(r.escalated).toBe(true);
    expect(after.suppressed).toBe(false); // even a low-confidence hard-no does nothing automated
    expect(after.score).toBe(before.score);
    expect(after.nextTouchAt).toBe(before.nextTouchAt); // sequence untouched
  });

  it('unknown senders are flagged, not actioned', () => {
    const r = routeReply('stranger@nowhere.com', cls('POSITIVE_INTERESTED'), 'hi', T0);
    expect(r.action).toBe('unknown-sender');
    expect(r.escalated).toBe(true);
  });
});

describe('per-class routing', () => {
  it('POSITIVE_INTERESTED scores +35 and wants a response draft', () => {
    const email = lead();
    const r = routeReply(email, cls('POSITIVE_INTERESTED'), 'keen!', T0);
    const l = getLeadByEmail(email)!;
    expect(l.score).toBe(35);
    expect(l.temperature).toBe('Warm');
    expect(r.wantsResponseDraft).toBe(true);
    const alerts = db().prepare("SELECT COUNT(*) c FROM alerts_log WHERE type='positive_reply' AND lead_id=?").get(l.id) as { c: number };
    expect(alerts.c).toBe(1);
  });

  it('QUESTION scores +15 and wants a response draft', () => {
    const email = lead();
    const r = routeReply(email, cls('QUESTION'), 'what does a day cost?', T0);
    expect(getLeadByEmail(email)!.score).toBe(15);
    expect(r.wantsResponseDraft).toBe(true);
  });

  it('POSITIVE_LATER captures the named date into nextTouchAt (send-window snapped)', () => {
    const email = lead();
    routeReply(email, cls('POSITIVE_LATER', { resumeDate: '2026-11-16' }), 'try me mid-November', T0);
    const l = getLeadByEmail(email)!;
    expect(l.nextTouchAt).not.toBeNull();
    const when = new Date(l.nextTouchAt!);
    expect(when.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-16'));
    expect([2, 3, 4]).toContain(when.getUTCDay()); // Tue–Thu
  });

  it('REFERRAL_REDIRECT creates the colleague as a Referral lead', () => {
    const email = lead({ company: 'ProdCo' });
    routeReply(email, cls('REFERRAL_REDIRECT', { referral: { email: 'boss@prodco.co.uk', name: 'Sam' } }), 'talk to Sam', T0);
    const created = getLeadByEmail('boss@prodco.co.uk')!;
    expect(created.source).toBe('Referral');
    expect(created.company).toBe('ProdCo');
  });

  it('NEUTRAL_OOO reschedules without scoring', () => {
    const email = lead();
    routeReply(email, cls('NEUTRAL_OOO', { resumeDate: '2026-09-07' }), 'back 7 Sept', T0);
    const l = getLeadByEmail(email)!;
    expect(l.score).toBe(0); // no points for an autoresponder
    expect(Date.parse(l.nextTouchAt!)).toBeGreaterThanOrEqual(Date.parse('2026-09-07'));
  });

  it('NEGATIVE_NOT_INTERESTED goes to Nurture with the 90-day quiet period', () => {
    const email = lead();
    routeReply(email, cls('NEGATIVE_NOT_INTERESTED'), 'not for us', T0);
    const l = getLeadByEmail(email)!;
    expect(l.temperature).toBe('Nurture');
    expect(Date.parse(l.nextTouchAt!) - T0.getTime()).toBeGreaterThanOrEqual(89 * 86_400_000);
  });

  it('HARD_NO_REMOVE suppresses immediately and permanently', () => {
    const email = lead();
    const r = routeReply(email, cls('HARD_NO_REMOVE'), 'REMOVE ME', T0);
    const l = getLeadByEmail(email)!;
    expect(l.temperature).toBe('Suppressed');
    expect(l.suppressed).toBe(true);
    expect(db().prepare('SELECT 1 FROM suppression WHERE email=?').get(email)).toBeTruthy();
    expect(r.wantsResponseDraft).toBe(true); // polite confirmation
  });

  it('BOUNCE disqualifies', () => {
    const email = lead();
    routeReply(email, cls('BOUNCE'), 'delivery failed', T0);
    expect(getLeadByEmail(email)!.temperature).toBe('Disqualified');
  });

  it('AUTO_REPLY is ignored entirely', () => {
    const email = lead();
    const before = getLeadByEmail(email)!;
    const r = routeReply(email, cls('AUTO_REPLY'), 'ticket #4521 received', T0);
    const after = getLeadByEmail(email)!;
    expect(r.action).toBe('ignored');
    expect(after.score).toBe(before.score);
  });
});

describe('suppression is idempotent across signals', () => {
  it('a suppressed lead cannot be re-warmed by later signals', () => {
    const email = lead();
    routeReply(email, cls('HARD_NO_REMOVE'), 'stop', T0);
    const l = getLeadByEmail(email)!;
    applySignal(l.id, 'reply_positive', { trigger: 'test', asOf: T0 });
    expect(getLeadByEmail(email)!.temperature).toBe('Suppressed');
  });
});
