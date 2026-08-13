import { describe, it, expect } from 'vitest';
import {
  leadToContactProperties,
  leadToMachineProperties,
  contactToLeadPatch,
  HUMAN_OWNED_FIELDS,
  MACHINE_OWNED_FIELDS,
} from '../src/hubspot/mapping.js';
import { makeLead } from './fixtures.js';

describe('leadToContactProperties', () => {
  it('serialises scalars to strings and omits nulls', () => {
    const p = leadToContactProperties(makeLead({ needsInput: null }));
    expect(p.email).toBe('jo@prodco.co.uk');
    expect(p.vedri_score).toBe('40');
    expect(p.vedri_sequence_step).toBe('2');
    expect(p.vedri_suppressed).toBe('false');
    expect(p).not.toHaveProperty('vedri_needs_input'); // null omitted
  });

  it('carries internal notes (they exist in HubSpot, just never in client copy)', () => {
    const p = leadToContactProperties(makeLead());
    expect(p.vedri_internal_notes).toContain('Assimilate Live FX');
  });
});

describe('leadToMachineProperties', () => {
  it('includes only machine-owned fields, never human-owned ones', () => {
    const p = leadToMachineProperties(makeLead());
    expect(p.vedri_score).toBe('40');
    expect(p.vedri_temperature).toBe('Warm');
    // Human-owned fields must NOT be pushed (HubSpot wins on those):
    expect(p).not.toHaveProperty('vedri_track');
    expect(p).not.toHaveProperty('vedri_source');
    expect(p).not.toHaveProperty('vedri_internal_notes');
    expect(p).not.toHaveProperty('email');
  });
});

describe('field ownership is partitioned', () => {
  it('no field is both human- and machine-owned', () => {
    for (const f of HUMAN_OWNED_FIELDS) {
      expect(MACHINE_OWNED_FIELDS.has(f)).toBe(false);
    }
  });
});

describe('round-trip', () => {
  it('recovers core fields through properties → patch', () => {
    const lead = makeLead();
    const patch = contactToLeadPatch(leadToContactProperties(lead));
    expect(patch.firstName).toBe('Jo');
    expect(patch.company).toBe('ProdCo');
    expect(patch.track).toBe('Studio');
    expect(patch.score).toBe(40);
    expect(patch.sequenceStep).toBe(2);
    expect(patch.suppressed).toBe(false);
    expect(patch.recommendedApproach).toBe('Green Screen');
  });

  it('parses suppressed=true back to a boolean', () => {
    const patch = contactToLeadPatch({ vedri_suppressed: 'true' });
    expect(patch.suppressed).toBe(true);
  });
});
