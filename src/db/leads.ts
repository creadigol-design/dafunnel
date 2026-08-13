/**
 * Leads repository — the local mirror CRUD used by sync, scoring, sequencing.
 *
 * Row (snake_case) ↔ Lead (camelCase) conversion lives here so the rest of the
 * codebase speaks only in the `Lead` type.
 */
import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import type { Lead } from '../types.js';

type Row = Record<string, unknown>;

export function rowToLead(r: Row): Lead {
  return {
    id: r.id as string,
    email: r.email as string,
    companyDomain: (r.company_domain as string | null) ?? null,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    company: (r.company as string | null) ?? null,
    track: r.track as Lead['track'],
    source: r.source as Lead['source'],
    temperature: r.temperature as Lead['temperature'],
    score: r.score as number,
    icpFit: (r.icp_fit as Lead['icpFit']) ?? null,
    recommendedApproach: (r.recommended_approach as Lead['recommendedApproach']) ?? null,
    internalNotes: (r.internal_notes as string | null) ?? null,
    liaBasis: (r.lia_basis as string | null) ?? null,
    needsInput: (r.needs_input as string | null) ?? null,
    needsConsent: Boolean(r.needs_consent),
    suppressed: Boolean(r.suppressed),
    suppressionReason: (r.suppression_reason as string | null) ?? null,
    sequenceId: (r.sequence_id as string | null) ?? null,
    sequenceStep: (r.sequence_step as number | null) ?? null,
    nextTouchAt: (r.next_touch_at as string | null) ?? null,
    lastEngagementAt: (r.last_engagement_at as string | null) ?? null,
    scoreUpdatedAt: (r.score_updated_at as string | null) ?? null,
    hubspotContactId: (r.hubspot_contact_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function getLeadByEmail(email: string): Lead | null {
  const r = db().prepare('SELECT * FROM leads WHERE email = ?').get(email) as Row | undefined;
  return r ? rowToLead(r) : null;
}

export function getLeadById(id: string): Lead | null {
  const r = db().prepare('SELECT * FROM leads WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToLead(r) : null;
}

export function allLeads(): Lead[] {
  const rows = db().prepare('SELECT * FROM leads ORDER BY created_at ASC').all() as Row[];
  return rows.map(rowToLead);
}

/** Insert or update a lead, keyed by id. Returns the persisted lead. */
export function upsertLead(input: Partial<Lead> & { email: string }): Lead {
  const now = new Date().toISOString();
  const existing = getLeadByEmail(input.email);
  const lead: Lead = {
    id: existing?.id ?? input.id ?? randomUUID(),
    email: input.email,
    companyDomain: input.companyDomain ?? existing?.companyDomain ?? null,
    firstName: input.firstName ?? existing?.firstName ?? null,
    lastName: input.lastName ?? existing?.lastName ?? null,
    company: input.company ?? existing?.company ?? null,
    track: input.track ?? existing?.track ?? 'Both',
    source: input.source ?? existing?.source ?? 'Other',
    temperature: input.temperature ?? existing?.temperature ?? 'Cold',
    score: input.score ?? existing?.score ?? 0,
    icpFit: input.icpFit ?? existing?.icpFit ?? null,
    recommendedApproach: input.recommendedApproach ?? existing?.recommendedApproach ?? null,
    internalNotes: input.internalNotes ?? existing?.internalNotes ?? null,
    liaBasis: input.liaBasis ?? existing?.liaBasis ?? null,
    needsInput: input.needsInput ?? existing?.needsInput ?? null,
    needsConsent: input.needsConsent ?? existing?.needsConsent ?? false,
    suppressed: input.suppressed ?? existing?.suppressed ?? false,
    suppressionReason: input.suppressionReason ?? existing?.suppressionReason ?? null,
    sequenceId: input.sequenceId ?? existing?.sequenceId ?? null,
    sequenceStep: input.sequenceStep ?? existing?.sequenceStep ?? null,
    nextTouchAt: input.nextTouchAt ?? existing?.nextTouchAt ?? null,
    lastEngagementAt: input.lastEngagementAt ?? existing?.lastEngagementAt ?? null,
    scoreUpdatedAt: input.scoreUpdatedAt ?? existing?.scoreUpdatedAt ?? null,
    hubspotContactId: input.hubspotContactId ?? existing?.hubspotContactId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveLead(lead);
  return lead;
}

/** Persist a fully-formed Lead (overwrites the row). */
export function saveLead(lead: Lead): void {
  db()
    .prepare(
      `INSERT INTO leads (
        id, email, company_domain, first_name, last_name, company, track, source,
        temperature, score, icp_fit, recommended_approach, internal_notes, lia_basis,
        needs_input, needs_consent, suppressed, suppression_reason, sequence_id,
        sequence_step, next_touch_at, last_engagement_at, score_updated_at,
        hubspot_contact_id, created_at, updated_at
      ) VALUES (
        @id, @email, @companyDomain, @firstName, @lastName, @company, @track, @source,
        @temperature, @score, @icpFit, @recommendedApproach, @internalNotes, @liaBasis,
        @needsInput, @needsConsent, @suppressed, @suppressionReason, @sequenceId,
        @sequenceStep, @nextTouchAt, @lastEngagementAt, @scoreUpdatedAt,
        @hubspotContactId, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, company_domain=excluded.company_domain,
        first_name=excluded.first_name, last_name=excluded.last_name,
        company=excluded.company, track=excluded.track, source=excluded.source,
        temperature=excluded.temperature, score=excluded.score, icp_fit=excluded.icp_fit,
        recommended_approach=excluded.recommended_approach, internal_notes=excluded.internal_notes,
        lia_basis=excluded.lia_basis, needs_input=excluded.needs_input,
        needs_consent=excluded.needs_consent, suppressed=excluded.suppressed,
        suppression_reason=excluded.suppression_reason, sequence_id=excluded.sequence_id,
        sequence_step=excluded.sequence_step, next_touch_at=excluded.next_touch_at,
        last_engagement_at=excluded.last_engagement_at, score_updated_at=excluded.score_updated_at,
        hubspot_contact_id=excluded.hubspot_contact_id, updated_at=excluded.updated_at`,
    )
    .run({
      ...lead,
      needsConsent: lead.needsConsent ? 1 : 0,
      suppressed: lead.suppressed ? 1 : 0,
    });
}
