/**
 * Governor maths — pure projection + recommendation logic, and the schedule
 * gate. The governor must never pretend assumptions are actuals, and never
 * claim to have changed volume itself.
 */
import { describe, it, expect } from 'vitest';
import { projectCloses, recommend, governorDue, type BandCounts } from '../src/governor.js';

function counts(patch: Partial<BandCounts> = {}): BandCounts {
  return { Hot: 0, Warm: 0, Cold: 0, Nurture: 0, closedWonThisMonth: 0, ...patch };
}

describe('projectCloses', () => {
  it('projects zero for an empty pipeline', () => {
    const p = projectCloses(counts(), 0);
    expect(p.projected).toBe(0);
    expect(p.usingDefaults).toBe(true);
  });
  it('weights bands by close probability and adds closes so far', () => {
    const p = projectCloses(counts({ Hot: 4, Warm: 10, closedWonThisMonth: 1 }), 0);
    expect(p.pipelineExpectation).toBeCloseTo(4 * 0.35 + 10 * 0.1, 5);
    expect(p.projected).toBeCloseTo(1 + 2.4, 5);
  });
  it('switches off the defaults flag at the data threshold', () => {
    expect(projectCloses(counts(), 29).usingDefaults).toBe(true);
    expect(projectCloses(counts(), 30).usingDefaults).toBe(false);
  });
});

describe('recommend', () => {
  it('behind pace → asks for specific extra cold volume, never silently changes it', () => {
    const r = recommend(projectCloses(counts({ Warm: 5 }), 0)); // 0.5 projected
    expect(r.status).toBe('behind');
    expect(r.extraColdContacts).toBeGreaterThan(0);
    expect(r.message).toMatch(/Nothing has been changed automatically/);
    expect(r.message).toMatch(/DEFAULT conversion assumptions/);
  });
  it('over capacity → throttle + price suggestion', () => {
    const r = recommend(projectCloses(counts({ Hot: 12 }), 0)); // 4.2 projected
    expect(r.status).toBe('over-capacity');
    expect(r.message).toMatch(/raising prices/);
  });
  it('on pace → no volume change', () => {
    const r = recommend(projectCloses(counts({ Hot: 6, closedWonThisMonth: 0 }), 0)); // 2.1
    expect(r.status).toBe('on-pace');
    expect(r.extraColdContacts).toBe(0);
  });
});

describe('governorDue', () => {
  it('runs on the 1st and 15th only', () => {
    expect(governorDue(new Date('2026-08-01T09:00:00Z'), null)).toBe(true);
    expect(governorDue(new Date('2026-08-15T09:00:00Z'), null)).toBe(true);
    expect(governorDue(new Date('2026-08-14T09:00:00Z'), null)).toBe(false);
  });
  it('runs once per due day', () => {
    expect(governorDue(new Date('2026-08-15T12:00:00Z'), '2026-08-15T09:00:00Z')).toBe(false);
    expect(governorDue(new Date('2026-08-15T12:00:00Z'), '2026-08-01T09:00:00Z')).toBe(true);
  });
  it('force overrides the schedule', () => {
    expect(governorDue(new Date('2026-08-14T09:00:00Z'), null, true)).toBe(true);
  });
});
