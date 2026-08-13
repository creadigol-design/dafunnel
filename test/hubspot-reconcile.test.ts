import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/hubspot/reconcile.js';
import type { HubSpotContact } from '../src/hubspot/client.js';
import { makeLead } from './fixtures.js';

function remote(properties: Record<string, string | null>, id = 'hs-1'): HubSpotContact {
  return { id, properties };
}

describe('reconcile — HubSpot wins human-edited fields', () => {
  it('adopts a name Daniel corrected in HubSpot', () => {
    const local = makeLead({ firstName: 'Jo' });
    const r = reconcile(local, remote({ firstname: 'Joanna', email: local.email }));
    expect(r.lead.firstName).toBe('Joanna');
    expect(r.humanOverrides).toContain('firstname');
  });

  it('adopts a track Daniel reassigned', () => {
    const local = makeLead({ track: 'Studio' });
    const r = reconcile(local, remote({ vedri_track: 'VFX' }));
    expect(r.lead.track).toBe('VFX');
    expect(r.humanOverrides).toContain('vedri_track');
  });

  it('does not flag an override when human fields match', () => {
    const local = makeLead({ firstName: 'Jo', track: 'Studio' });
    const r = reconcile(local, remote({ firstname: 'Jo', vedri_track: 'Studio' }));
    expect(r.humanOverrides).toHaveLength(0);
  });
});

describe('reconcile — we win machine fields', () => {
  it('keeps the local score and stages it to push, ignoring a stale remote score', () => {
    const local = makeLead({ score: 55, temperature: 'Hot' });
    const r = reconcile(local, remote({ vedri_score: '10', vedri_temperature: 'Cold' }));
    // Local machine values are authoritative:
    expect(r.lead.score).toBe(55);
    expect(r.lead.temperature).toBe('Hot');
    // …and they are what we push up:
    expect(r.pushProperties.vedri_score).toBe('55');
    expect(r.pushProperties.vedri_temperature).toBe('Hot');
  });

  it('stamps the HubSpot contact id onto the merged lead', () => {
    const r = reconcile(makeLead({ hubspotContactId: null }), remote({}, 'hs-999'));
    expect(r.lead.hubspotContactId).toBe('hs-999');
  });
});
