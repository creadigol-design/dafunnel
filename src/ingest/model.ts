/**
 * Shared ingestion types. Every adapter (inbound, built lists, LinkedIn,
 * reactivation, Mailchimp) produces `RawLead`s, which normalise into
 * `LeadDraft`s and are deduped before hitting the leads repository.
 */
import type { Lead, LeadSource, Track, RecommendedApproach } from '../types.js';

/** What an adapter emits before normalisation/validation. */
export interface RawLead {
  email?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  companyDomain?: string;
  phone?: string;
  source: LeadSource;
  track?: Track;
  recommendedApproach?: RecommendedApproach;
  internalNotes?: string;
  lastEngagementAt?: string;
  /** Free-text provenance, e.g. "LinkedIn", "BSC networking". */
  provenance?: string;
  /** Original untouched row/fields, for audit. */
  raw?: Record<string, string>;
}

/** A validated, normalised lead ready to upsert. */
export type LeadDraft = Partial<Lead> & { email: string };

export interface RowIssue {
  row: number;
  email?: string;
  reason: string;
}

/** Per-import validation report — surfaced to Daniel, never silently dropped. */
export interface ImportReport {
  source: string;
  file?: string;
  total: number;
  imported: number;
  duplicatesInFile: number;
  rejected: RowIssue[];
  warnings: RowIssue[];
  /** Role-inbox addresses (info@, hello@…) — lower priority, still imported. */
  roleAccounts: string[];
  /** Freemail/individual addresses flagged as needing consent (PECR). */
  needsConsent: string[];
  bySource: Record<string, number>;
}

export function emptyReport(source: string, file?: string): ImportReport {
  return {
    source,
    file,
    total: 0,
    imported: 0,
    duplicatesInFile: 0,
    rejected: [],
    warnings: [],
    roleAccounts: [],
    needsConsent: [],
    bySource: {},
  };
}
