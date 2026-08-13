/**
 * Scoring state-machine tests — the part that silently rots, so it's tested hard:
 * band boundaries, decay maths, signal accumulation, idempotency, terminal
 * transitions, the Nurture floor, and alert emission on band change.
 *
 * Uses a throwaway DB via DB_PATH (set before importing anything config-bound).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vedri-score-'));
process.env.DB_PATH = join(tmp, 'score.db');
process.env.LOG_DIR = join(tmp, 'logs');
process.env.HUBSPOT_PRIVATE_APP_TOKEN = '';

const { db, closeDb } = await import('../src/db/index.js');
const { upsertLead, getLeadByEmail } = await import('../src/db/leads.js');
const scoring = await import('../src/scoring.js');
const {
  computeBand,
  clampScore,
  decayPoints,
  applySignal,
  applyTransition,
  recomputeScore,
  ensureSeedSignals,
  isTerminal,
} = scoring;

const DAY = 86_400_000;
const T0 = new Date('2026-08-01T00:00:00.000Z');
function daysLater(n: number): Date {
  return new Date(T0.getTime() + n * DAY);
}

let counter = 0;
function freshLead(patch: Record<string, unknown> = {}): string {
  const email = `lead${counter++}@prodco.co.uk`;
  const lead = upsertLead({ email, createdAt: T0.toISOString(), ...patch });
  return lead.id;
}

// The leads table persists across tests in one file; use fresh emails per test.
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('pure band + clamp maths', () => {
  it('bands at the exact boundaries', () => {
    expect(computeBand(0)).toBe('Cold');
    expect(computeBand(24)).toBe('Cold');
    expect(computeBand(25)).toBe('Warm');
    expect(computeBand(54)).toBe('Warm');
    expect(computeBand(55)).toBe('Hot');
    expect(computeBand(100)).toBe('Hot');
  });
  it('clamps and rounds', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(105)).toBe(100);
    expect(clampScore(40.6)).toBe(41);
  });
});

describe('decay maths', () => {
  it('is −3 per full week since last engagement', () => {
    const created = T0.toISOString();
    expect(decayPoints(null, created, daysLater(6))).toBe(0);
    expect(decayPoints(null, created, daysLater(7))).toBe(3);
    expect(decayPoints(null, created, daysLater(13))).toBe(3);
    expect(decayPoints(null, created, daysLater(14))).toBe(6);
    expect(decayPoints(null, created, daysLater(70))).toBe(30);
  });
  it('measures from lastEngagementAt when present', () => {
    expect(decayPoints(daysLater(10).toISOString(), T0.toISOString(), daysLater(17))).toBe(3);
  });
});

describe('signal accumulation + bands', () => {
  it('a positive reply warms, a booked call turns it hot and alerts', () => {
    const id = freshLead();
    const r1 = applySignal(id, 'reply_positive', { trigger: 't', asOf: T0 })!;
    expect(r1.newScore).toBe(35);
    expect(r1.newBand).toBe('Warm');

    const r2 = applySignal(id, 'discovery_booked', { trigger: 't', asOf: T0 })!;
    expect(r2.newScore).toBe(75);
    expect(r2.newBand).toBe('Hot');
    expect(r2.bandChanged).toBe(true);

    const hotAlerts = db()
      .prepare("SELECT COUNT(*) n FROM alerts_log WHERE lead_id = ? AND type = 'lead_became_hot'")
      .get(id) as { n: number };
    expect(hotAlerts.n).toBe(1);
  });

  it('is idempotent for keyed one-time signals', () => {
    const id = freshLead();
    const first = applySignal(id, 'proposal_sent', { trigger: 't', idempotencyKey: 'k1', asOf: T0 });
    const second = applySignal(id, 'proposal_sent', { trigger: 't', idempotencyKey: 'k1', asOf: T0 });
    expect(first?.newScore).toBe(20);
    expect(second).toBeNull(); // skipped
    expect(getLeadByEmail(`lead${counter - 1}@prodco.co.uk`)?.score).toBe(20);
  });
});

describe('decay applied over time via recompute', () => {
  it('cools a warm lead to cold after enough silence', () => {
    const id = freshLead();
    applySignal(id, 'link_clicked', { trigger: 't', asOf: T0 }); // +8
    applySignal(id, 'reply_neutral', { trigger: 't', asOf: T0 }); // +12 → 20 Cold
    applySignal(id, 'named_budget_or_date', { trigger: 't', asOf: T0 }); // +20 → 40 Warm

    // 14 days of silence → 40 − 6 = 34, still Warm.
    const a = recomputeScore(id, 'nightly', daysLater(14));
    expect(a.newScore).toBe(34);
    expect(a.newBand).toBe('Warm');

    // 100 days of silence → 40 − 42 = 0, Cold; band changed.
    const b = recomputeScore(id, 'nightly', daysLater(100));
    expect(b.newScore).toBe(0);
    expect(b.newBand).toBe('Cold');
    expect(b.bandChanged).toBe(true);
  });
});

describe('terminal + holding transitions', () => {
  it('hard no suppresses permanently and records suppression', () => {
    const id = freshLead();
    const email = getLeadByEmail(`lead${counter - 1}@prodco.co.uk`)!.email;
    const r = applyTransition(id, 'hard_no', { trigger: 't', reason: 'remove me', asOf: T0 });
    expect(r.newBand).toBe('Suppressed');
    const supp = db().prepare('SELECT COUNT(*) n FROM suppression WHERE email = ?').get(email) as { n: number };
    expect(supp.n).toBe(1);
    // Terminal: further signals do not move a suppressed lead.
    const after = recomputeScore(id, 'nightly', daysLater(1));
    expect(after.newBand).toBe('Suppressed');
    expect(isTerminal('Suppressed')).toBe(true);
  });

  it('negative reply drops to Nurture with a 90-day quiet period and floor 15', () => {
    const id = freshLead();
    applySignal(id, 'reply_positive', { trigger: 't', asOf: T0 }); // 35 Warm
    const r = applyTransition(id, 'reply_negative', { trigger: 't', asOf: T0 });
    expect(r.newBand).toBe('Nurture');
    expect(r.newScore).toBe(35); // max(15, 35)

    // Nurture is sticky at the floor even after long silence.
    const later = recomputeScore(id, 'nightly', daysLater(120));
    expect(later.newBand).toBe('Nurture');
    expect(later.newScore).toBe(15);

    const lead = getLeadByEmail(`lead${counter - 1}@prodco.co.uk`)!;
    expect(Date.parse(lead.nextTouchAt!)).toBeGreaterThan(T0.getTime());
  });

  it('hard bounce disqualifies', () => {
    const id = freshLead();
    const r = applyTransition(id, 'bounce_hard', { trigger: 't', asOf: T0 });
    expect(r.newBand).toBe('Disqualified');
  });
});

describe('seed bonuses', () => {
  it('gives a past client +15 once, idempotently, without resetting decay', () => {
    const id = freshLead({ source: 'Past Client' });
    ensureSeedSignals(id, T0);
    ensureSeedSignals(id, T0); // second call must not double-count
    const r = recomputeScore(id, 'nightly', T0);
    expect(r.newScore).toBe(15);
  });

  it('adds ICP-fit +10 for High fit', () => {
    const id = freshLead({ icpFit: 'High' });
    ensureSeedSignals(id, T0);
    const r = recomputeScore(id, 'nightly', T0);
    expect(r.newScore).toBe(10);
  });
});
