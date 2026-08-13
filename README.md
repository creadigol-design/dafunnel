# vedrí — Automated Sales Funnel

An automated sales funnel and follow-up engine for **vedrí**, running two brand
tracks off one engine: **Studio** (virtual production) and **VFX** (post/finishing).

**The single success metric: 2 closed jobs per month, combined across both tracks.**

HubSpot (free tier) is the system of record and the UI Daniel looks at. All logic,
scheduling, scoring and sending live in this code — HubSpot's free tier has no
workflows or sequences, so we never depend on them.

> **Status:** Phase 1 complete (scaffold, config, SQLite, logging, `cycle`).
> See `docs/PHASE-0-PLAN.md` for the full build plan and phases.

---

## Safety model — read this first

The system ships **safe**. Two flags in `.env` gate anything that could touch the
outside world:

| Flag | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | Shadow mode: everything computes, drafts are written to `output/drafts/` as files, **nothing sends**, and **no HubSpot writes** happen. |
| `AUTO_SEND_FOLLOWUPS` | `false` | Every outbound email is a **Gmail draft Daniel sends by hand**. The auto-send path exists but is off. |

`pnpm run doctor` always prints the current state of both flags at the top, so
you can never be surprised about whether the system can send.

### Kill it fast

- **Stop all sending immediately:** set `AUTO_SEND_FOLLOWUPS=false` in `.env` (or
  it already is). Drafts stop leaving without a human.
- **Stop everything, including HubSpot writes:** set `DRY_RUN=true`.
- **Full stop:** disable the scheduled cycle (GitHub Actions workflow / cron) and
  the system goes dormant. Nothing runs unless `pnpm run cycle` is invoked.

---

## Requirements

- Node ≥ 22, `pnpm`
- `better-sqlite3` builds a native binding on install (a prebuilt binary is used
  when available). If install skips it, run `pnpm rebuild better-sqlite3`.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in secrets as each phase needs them
pnpm run cycle         # runs one dry-run pass; creates data/vedri-funnel.db
pnpm run doctor        # health check
pnpm test              # unit + smoke tests
```

No secrets are required to run Phase 1 — it touches no live system. Later phases
assert the specific credentials they need at the point of use.

## Commands

| Command | What it does |
|---|---|
| `pnpm run cycle` | One pass of the funnel: ingest → reconcile → score → sequence → replies → governor → alerts → dashboard. Steps light up as their phases land. |
| `pnpm run doctor` | Health check: safety flags, DB, last cycle, suppression list, free-tier headroom, credential presence. |
| `pnpm run explain <email>` | Full event history + score derivation for one lead — answers "why is this hot?" |
| `pnpm run typecheck` | `tsc --noEmit`. |
| `pnpm test` | Vitest suite. |

## Layout

```
config/            typed config (index.ts), funnel model, alert routing
src/
  types.ts         core domain vocabulary (Lead, Temperature, Track, …)
  logger.ts        structured JSON logging
  cycle.ts         the `pnpm run cycle` orchestrator
  db/              SQLite schema, migrations, append-only event log
scripts/           doctor, explain (more per phase)
test/              vitest suites
docs/              PHASE-0-PLAN, and (coming) FUNNEL-MODEL, COMPLIANCE
```

## How to change copy

Sequences will be declared in `sequences/*.yaml` (Phase 5) so copy can be edited
without touching code. Every generated draft passes a lint check (banned fluff,
American spellings, internal kit terminology, unresolved `{{NEEDS_INPUT}}`,
missing unsubscribe, >150 words, >1 question mark) before it can reach a human.

## How to switch auto-send on (later, per sequence)

Once copy has proven itself in drafts, auto-send can be enabled **per sequence**.
The global `AUTO_SEND_FOLLOWUPS=true` flag arms it; per-sequence config decides
which sequences actually auto-send. It ships off and stays off until Daniel
decides otherwise.

## Compliance

UK GDPR + PECR. Suppression is checked before **every** send; one-click
unsubscribe is in every message; sole traders / partnerships are flagged at
import as needing consent. `docs/COMPLIANCE.md` (Phase 7) holds the
legitimate-interest assessment. **This is engineering to a known standard, not
legal advice — have it sanity-checked by someone qualified before cold sending.**
