/**
 * Normalisation + validation — the one gate every raw lead passes through.
 *
 * Pure and unit-tested. Turns a messy `RawLead` into either a clean `LeadDraft`
 * or a rejection reason, and raises the flags UK compliance cares about
 * (role inboxes, freemail/individual subscribers needing consent).
 */
import type { RawLead, LeadDraft } from './model.js';

/** Free webmail domains → treat the person as an individual subscriber (PECR consent). */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'btinternet.com', 'sky.com', 'msn.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
]);

/** Local-parts that indicate a shared role inbox, not a person. */
export const ROLE_LOCALPARTS = new Set([
  'info', 'hello', 'hi', 'contact', 'admin', 'office', 'enquiries', 'enquiry',
  'sales', 'team', 'mail', 'support', 'accounts', 'hey', 'studio', 'bookings',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

export function isFreemail(email: string): boolean {
  const d = extractDomain(email);
  return d ? FREEMAIL_DOMAINS.has(d) : false;
}

export function isRoleAccount(email: string): boolean {
  const local = email.slice(0, email.indexOf('@')).toLowerCase();
  // Strip +tags, e.g. info+leads@ → info.
  const base = local.split('+')[0] ?? local;
  return ROLE_LOCALPARTS.has(base);
}

export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export interface NormaliseResult {
  draft?: LeadDraft;
  reject?: string;
  warnings: string[];
  roleAccount: boolean;
  needsConsent: boolean;
}

/** Default legitimate-interest basis for B2B corporate cold contacts. */
const B2B_LIA =
  'B2B corporate subscriber. Legitimate interest: relevant virtual-production / VFX service to a production business; one-click opt-out honoured; suppression checked before every send.';

export function normaliseRawLead(raw: RawLead): NormaliseResult {
  const warnings: string[] = [];

  const email = (raw.email ?? '').trim().toLowerCase();
  if (!email) return { reject: 'missing email', warnings, roleAccount: false, needsConsent: false };
  if (!isValidEmail(email)) {
    return { reject: `invalid email: ${email}`, warnings, roleAccount: false, needsConsent: false };
  }

  const roleAccount = isRoleAccount(email);
  const freemail = isFreemail(email);
  const needsConsent = freemail; // individual subscriber → consent, not legitimate interest

  let firstName = raw.firstName ?? null;
  let lastName = raw.lastName ?? null;
  if (!firstName && !lastName && raw.fullName) {
    ({ firstName, lastName } = splitName(raw.fullName));
  }

  const company = raw.company?.trim() || null;
  if (!company) warnings.push('missing company');
  const companyDomain = raw.companyDomain?.toLowerCase() ?? (freemail ? null : extractDomain(email));

  const draft: LeadDraft = {
    email,
    firstName,
    lastName,
    company,
    companyDomain,
    source: raw.source,
    track: raw.track ?? 'Both',
    recommendedApproach: raw.recommendedApproach ?? null,
    internalNotes: raw.internalNotes ?? null,
    lastEngagementAt: raw.lastEngagementAt ?? null,
    needsConsent,
    // Freemail/individuals need consent, so no legitimate-interest basis is asserted.
    liaBasis: needsConsent ? null : B2B_LIA,
  };

  return { draft, warnings, roleAccount, needsConsent };
}
