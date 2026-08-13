/**
 * Dedupe helpers. Cross-run dedupe is free because `upsertLead` keys on email,
 * so re-importing merges rather than duplicates. This handles WITHIN-file
 * duplicates (the same email twice in one CSV) and surfaces same-domain
 * clusters for awareness.
 */
import type { LeadDraft } from './model.js';

export interface DedupeResult {
  unique: LeadDraft[];
  duplicates: number;
}

/** Collapse duplicate emails within a single batch, keeping the first seen. */
export function dedupeByEmail(drafts: LeadDraft[]): DedupeResult {
  const seen = new Set<string>();
  const unique: LeadDraft[] = [];
  let duplicates = 0;
  for (const d of drafts) {
    const key = d.email.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(d);
  }
  return { unique, duplicates };
}

/** Group drafts by company domain — useful to spot multiple contacts at one firm. */
export function groupByDomain(drafts: LeadDraft[]): Map<string, LeadDraft[]> {
  const map = new Map<string, LeadDraft[]>();
  for (const d of drafts) {
    const key = d.companyDomain ?? '(none)';
    const arr = map.get(key) ?? [];
    arr.push(d);
    map.set(key, arr);
  }
  return map;
}
