# COMPLIANCE — UK GDPR + PECR

> **This is engineering to a known standard, not legal advice.** Daniel should
> have this document sanity-checked by someone qualified before cold outreach
> begins (a solicitor, or the ICO's small-business guidance as a first pass).

## Lawful basis, per audience

| Audience | Basis | Where recorded |
|---|---|---|
| B2B corporate subscribers (limited companies, LLPs) | **Legitimate interest** (PECR permits B2B email to corporate subscribers; UK GDPR Art. 6(1)(f)) | `vedri_lia_basis` on every contact, set at import |
| Sole traders & unincorporated partnerships | Treated as **individual subscribers → consent required** | Flagged `needs_consent` at import; **never cold-mailed**; cold sequences skip them automatically |
| Website opt-ins (Mailchimp signups) | **Consent** | `vedri_lia_basis` = "Consent — website opt-in via Mailchimp" |
| Past clients | Legitimate interest (existing relationship; soft opt-in reasoning) | LIA basis + provenance in internal notes |

Freemail addresses (gmail/yahoo/etc.) are treated as individual subscribers by
default — the system cannot verify a company stands behind them, so it errs on
the side of consent-required.

## Legitimate Interest Assessment (LIA) — the three-part test

1. **Purpose.** Offering virtual-production and VFX services to production
   businesses that plausibly need them. A real commercial interest, plainly
   stated in every message.
2. **Necessity.** Direct email to named, role-relevant people at production
   companies is the proportionate way to reach this market; volume is capped
   (~34 cold/day), targeting is ICP-scoped (production sector, UK/IE), and
   contacts exit on any negative signal.
3. **Balancing.** Recipients are business decision-makers contacted about their
   business; content is relevant and brief (≤150 words); a one-click opt-out is
   honoured permanently; individuals (sole traders) are excluded rather than
   balanced. On these facts the interference is minimal and expected in a B2B
   context.

Reviewed by: Daniel Evans. Review date: _at cold go-live, then annually_.

## What every outbound message carries (enforced in code)

- **Sender identity:** "Daniel Evans, vedrí" — no anonymous or misleading sender
  (rendered footer, `src/copy/render.ts`).
- **Postal address:** Bangor, Gwynedd, North Wales.
- **One-click unsubscribe:** a mailto link; the lint pass **hard-fails any
  message missing it** — an email without an unsubscribe cannot leave the
  system (`src/copy/lint.ts`).

## Suppression — the permanent do-not-contact list

- Any "remove me"/unsubscribe/complaint → `Suppressed`: written to the
  `suppression` table **and** `vedri_suppressed` in HubSpot; a polite
  confirmation is drafted; the state is terminal and cannot be re-warmed by any
  later signal (unit-tested).
- **The suppression list is checked before every single send** — at sequence
  time and again at draft-persistence time.
- Reply classification is confidence-gated (≥0.8): an ambiguous message is
  escalated to a human rather than acted on, so a missed removal demand cannot
  be silently ignored — and a clear one is always honoured automatically.
- Suppressed records are retained (email + reason + date) — deleting them would
  destroy the evidence that we must not contact them.

## Sending-reputation separation

Cold outreach goes only from a separate warmed sending domain (`fromMailbox:
cold` in sequence YAML, blocked until the domain exists); replies, warm leads
and past clients use `info@vedri.studio`. This is deliverability hygiene, but
also compliance hygiene: cold volume cannot contaminate the studio's primary
correspondence identity.

## Data-protection housekeeping

- **What's held:** business contact details, engagement events, correspondence
  drafts — in HubSpot (EU data centre, portal 149092923) and a SQLite mirror on
  the VPS. Secrets live in `.env`, never in the repository.
- **Access:** Daniel only (single-operator business).
- **Subject rights:** `pnpm run explain <email>` produces a complete, timestamped
  record for any contact — this satisfies an access request for what the system
  holds; deletion = HubSpot delete + SQLite row delete + (if they objected)
  a retained suppression entry, which is itself a GDPR-compliant minimal record.
- **Retention:** leads with no engagement are decayed to Cold/Nurture
  automatically; a periodic cull of never-engaged cold imports older than ~12
  months is recommended (manual for now).

## Checklist before cold go-live (Phase 10)

- [ ] Sending domain bought, SPF + DKIM + DMARC passing, warmed ≥3 weeks
- [ ] This LIA reviewed by someone qualified
- [ ] Suppression list non-empty check green in `pnpm run doctor`
- [ ] `SEQUENCES_ACTIVE` gains cold only after reactivation + inbound have run clean
