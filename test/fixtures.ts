import type { Lead } from '../src/types.js';

/** A fully-populated Lead for tests. Override any field via `patch`. */
export function makeLead(patch: Partial<Lead> = {}): Lead {
  const now = '2026-08-13T00:00:00.000Z';
  return {
    id: 'lead-test-1',
    email: 'jo@prodco.co.uk',
    companyDomain: 'prodco.co.uk',
    firstName: 'Jo',
    lastName: 'Rhys',
    company: 'ProdCo',
    track: 'Studio',
    source: 'Built List',
    temperature: 'Warm',
    score: 40,
    icpFit: 'High',
    recommendedApproach: 'Green Screen',
    internalNotes: 'INTERNAL: full cyc, Assimilate Live FX',
    liaBasis: 'B2B corporate subscriber, relevant VP service',
    needsInput: null,
    needsConsent: false,
    suppressed: false,
    suppressionReason: null,
    sequenceId: 'A2',
    sequenceStep: 2,
    nextTouchAt: '2026-08-15T08:00:00.000Z',
    lastEngagementAt: '2026-08-12T09:00:00.000Z',
    scoreUpdatedAt: now,
    hubspotContactId: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
