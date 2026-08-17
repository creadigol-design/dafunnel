/**
 * Sequence selection + send-window scheduling. No DB or API — pure routing.
 */
import { describe, it, expect } from 'vitest';
import { selectSequence } from '../src/sequences/load.js';
import { snapToSendWindow } from '../src/sequences/schedule.js';
import { makeLead } from './fixtures.js';

describe('selectSequence', () => {
  it('routes a Studio past client to reactivation', () => {
    expect(selectSequence(makeLead({ track: 'Studio', source: 'Past Client' }))?.id).toBe('A3-reactivation');
  });
  it('routes a Studio built-list lead to cold', () => {
    expect(selectSequence(makeLead({ track: 'Studio', source: 'Built List' }))?.id).toBe('A2-cold');
  });
  it('prospector-approved leads take the personal intro over the bulk cold program', () => {
    const lead = makeLead({
      track: 'Studio',
      source: 'Built List',
      internalNotes: 'Prospector: fits the ICP · evidence: https://example.com',
    });
    expect(selectSequence(lead)?.id).toBe('A4-outreach');
  });
  it('active sequences win a contested source', () => {
    const lead = makeLead({ track: 'Studio', source: 'Built List' });
    expect(selectSequence(lead, undefined, new Set(['A4-outreach']))?.id).toBe('A4-outreach');
    expect(selectSequence(lead, undefined, new Set(['A2-cold']))?.id).toBe('A2-cold');
  });
  it('routes an inbound Studio lead to the inbound sequence', () => {
    expect(selectSequence(makeLead({ track: 'Studio', source: 'Decision Matrix' }))?.id).toBe('A1-inbound');
  });
  it('routes a VFX past client to the VFX reactivation sequence', () => {
    expect(selectSequence(makeLead({ track: 'VFX', source: 'Past Client' }))?.id).toBe('B3-reactivation');
  });
  it('treats a "Both" lead as Studio', () => {
    expect(selectSequence(makeLead({ track: 'Both', source: 'Referral' }))?.id).toBe('A3-reactivation');
  });
});

describe('snapToSendWindow', () => {
  it('always lands on Tue, Wed or Thu', () => {
    // Sweep a fortnight of start dates; every result must be a send day.
    for (let i = 0; i < 14; i++) {
      const from = new Date(Date.UTC(2026, 7, 1 + i, 12, 0, 0)); // Aug 2026
      const day = snapToSendWindow(from).getUTCDay();
      expect([2, 3, 4]).toContain(day);
    }
  });
  it('never returns a slot before the input', () => {
    const from = new Date(Date.UTC(2026, 7, 3, 12, 0, 0));
    expect(snapToSendWindow(from).getTime()).toBeGreaterThan(from.getTime());
  });
});
