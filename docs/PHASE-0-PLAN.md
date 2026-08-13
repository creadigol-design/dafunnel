# Phase 0 — Discovery & Plan · vedrí Automated Sales Funnel

**Status: awaiting Daniel's approval. Nothing has been built or deployed.**
Prepared 2026-08-13. Success metric: **2 closed jobs / month, combined across both tracks.**

### Answers from Daniel (2026-08-13)
- **Decision-matrix form** → submits to `info@vedri.studio` (same inbox as the VFX form). Good — one inbound poller covers both.
- **Draft-approval windows:** Mon / Wed / Fri **09:00–11:00** (≈6 hrs/week). → Daily digest must land **before 09:00** on those days with drafts queued. Send windows are Tue–Thu, so: **Mon approval feeds Tue sends; Wed approval feeds Wed+Thu sends;** Fri session handles reactivation/inbound replies.
- **Discovery calls:** Mon–Fri **10:00–16:00** → call-slot offers pull live from the "Vedri" calendar within that window (Europe/London).
- **Past quotes:** live in **Google Drive** — confirmed a "Vedri Quotes" folder + named quotes/proposals (Pwrpas VED-Q-002, Our World, OnEarth, Business Wales, Y Streic Fawr VFX, Sgorio, +others). **~6+ warm reactivation contacts** to work first.
- **Project value:** **£7,000–£20,000** per job (midpoint ≈ £13.5k → 2 closes ≈ £27k/mo). Used for pipeline weighting + cost-per-close.
- **Capacity:** "depends on scope of work" — **still needs a working ceiling** (jobs/month per track) so the governor knows when to throttle vs push. Flagged.
- **Cold sending domain:** not purchased yet → I'll spec the DNS (SPF/DKIM/DMARC) for Daniel to set up; warming starts once it's live.
- **Slack channel:** to be created — recommendation below.

---

## 1. What already exists (honest findings)

I inspected the live systems rather than assume. Here is the real state:

### HubSpot portal — `149092923` (EU1, app-eu1.hubspot.com)
- **Brand new and essentially empty.** Daniel's user record was created *today* (2026-08-13). There are no bespoke pipelines, `vedri_` properties, or real contacts yet — this is a clean slate, which is good: we provision it exactly as designed with nothing to migrate.
- **Free-tier shape confirmed.** `CAMPAIGN` objects report `REQUIRES_ACCOUNT_MODIFICATION` (a paid feature). `CONTACT`, `COMPANY`, `DEAL`, `TASK`, `NOTE`, `CALL`, `MEETING_EVENT`, `PRODUCT`, `LINE_ITEM` are all read+write via the API — everything the design needs. This confirms the core constraint: **HubSpot is our database; all logic lives in our code.**
- **⚠️ Two settings are wrong for a UK studio and should be fixed before we write a single record:**
  - Account **currency = USD** → should be **GBP**.
  - Account **timezone = US/Eastern** → should be **Europe/London**.
  These affect deal values and every "days in stage" / SLA calculation. Daniel needs to change these in HubSpot settings (Settings → Account Defaults); the API can't. Flagged as an action item.
- Single `core` seat in use. Free tier caps at **2 users / 1,000 marketing contacts** — we'll track the contact count every cycle and alert at 800 (80%).

### Inbound (the highest-value channel)
- A **FormSubmit.co** form is live on **`vfx.vedri.studio`** (Track B / VFX), routing to `info@vedri.studio`, activated **25 Jul 2026**.
- To date it has received **only test submissions** (from Daniel's own `info@creadigol.design` / vedrí addresses). **Real inbound volume is currently ~0.**
- I did **not** find a feed for the main `vedri.studio` **VP decision-matrix** form. Two possibilities: it isn't wired to email yet, or it routes somewhere I can't see. **Question for Daniel below.**
- Implication: the funnel model assumes ~8 inbound enquiries/month. We are starting from zero inbound, so **reactivation + LinkedIn carry the first 60–90 days** while inbound and cold ramp.

### Calendars (Google)
- Accessible calendars: **"Vedri"**, **"Daniel Work"**, `info@creadigol.design`, and UK Holidays.
- **"Vedri"** is the natural target for pulling live call slots and writing discovery bookings. (Both Vedri/Daniel Work currently show timezone UTC — fine, but we'll present slots in Europe/London.)

### Not yet inspected (need Daniel / access)
- Past-client list & dead-quote history (location unknown — Gmail? a spreadsheet? nothing in HubSpot yet).
- LinkedIn connections export.
- The cold sending domain (`vedri-studio.com` / `getvedri.com`) — not yet purchased/configured as far as I can see.
- Slack workspace/channel for alerts.

**Bottom line:** less to untangle than the brief anticipated — the portal is clean, not a mess. The main gaps are (a) no real inbound yet, (b) no reactivation data imported, (c) sending domain not set up, (d) two HubSpot regional settings to fix.

---

## 2. Ideal Customer Profile — per track (draft, for Daniel to correct)

Starting hypotheses. **Challenge these — they're guesses until Daniel signs off.**

### Track A — vedrí Studio (virtual production)
- UK independent prodcos; branded-content & social agencies; podcast networks / multi-cam talk formats; corporate comms teams at mid-size brands; music labels doing performance content; broadcast indies.
- **Geographic sweet spot:** Manchester / Liverpool / Birmingham / Cardiff / Dublin — close enough to travel from North Wales, far enough from London to feel the cost of a London stage.
- **Lead the pitch with:** real-time compositing (final image on the monitors as you shoot) + multi-cam with no frustum limit.
- **ICP-fit scoring** keys on: sector match + company size band + within travel radius + does multi-cam / high-volume shoot days.

### Track B — vedrí VFX (post / finishing)
- Post houses overflowing on comp/cleanup; indie feature & short-form producers; ad agencies needing finishing; prodcos who shot green screen elsewhere and need it finished.
- Less geographically bound (post is deliverable remotely) — widens the addressable list.

**Open ICP questions for Daniel:** company-size band (crew size? turnover? both?), sectors to *exclude*, and whether Dublin (ROI) is in or out for VAT/logistics reasons.

---

## 3. The funnel maths — the volume you'd be committing to

Reverse-engineered from the model in `docs/FUNNEL-MODEL.md` (defaults, to be replaced by actuals once we have ≥30 data points per stage). Blended monthly plan to hit **2 closes**:

| Channel | Volume in / month | Approx closes |
|---|---|---|
| Inbound (site form / decision matrix) | ~8 qualified enquiries | ≈ 1.1 |
| Reactivation (past clients, old quotes) | ~15 contacts worked | ≈ 0.25 |
| LinkedIn / social (manual touch) | ~35 conversations | ≈ 0.3 |
| Cold outbound (built lists) | ~150 new contacts | ≈ 0.4 |
| **Total** | | **≈ 2.0** |

- Cold = 150 contacts × ~5 touches ≈ **750 emails/month ≈ 34/working day** — under Gmail limits, low enough to stay personalised.
- **Reality check given §1:** inbound is at zero today, so month 1–2 leans on reactivation (warmest, ~6× cold conversion, zero cost) and LinkedIn. **Cold goes last**, only after the sending domain has warmed ≥3 weeks.
- **This is the number to push back on now:** are you willing to feed ~150 new cold contacts + ~35 LinkedIn touches + work ~15 reactivation contacts every month? If capacity is the real ceiling (see §7), we throttle and raise prices instead of chasing volume.

---

## 4. Architecture & stack (recommendation + reasoning)

Default from the brief, and I agree with it — fewer moving parts, low cost, no lock-in, plain-text inspectable:

| Layer | Choice | Why |
|---|---|---|
| Language / runtime | **TypeScript + Node**, `pnpm` | Type safety on the scoring state machine; one language end to end |
| Local state / audit | **SQLite** via `better-sqlite3` | Append-only `events` log + mirror of HubSpot; system keeps working if HubSpot is unreachable; plain file, inspectable |
| System of record / UI | **HubSpot free** REST API v3 (private app) | Daniel's single pane of glass; we never depend on a HubSpot workflow/sequence |
| Email | **Gmail API** (OAuth), two mailboxes | `info@vedri.studio` (warm/inbound) + cold sending domain (cold only) |
| Calendar | **Google Calendar API** ("Vedri" calendar) | Live slot offers + writing discovery bookings |
| Copy + reply classification | **Claude API** | Draft generation + reply intent classification with confidence gating |
| Scheduling | **GitHub Actions cron** (or a small always-on box) | No extra infra; `pnpm run cycle` is the single entry point |
| Alerts | **Slack DM** (primary) + email fallback | Rate-limited, batched |

**Config flags that ship OFF / safe:** `AUTO_SEND_FOLLOWUPS: false` (draft-and-approve only), `DRY_RUN: true` for Phase 9. Per-sequence `fromMailbox`. Secrets in `.env`, never committed.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| **Sending-domain reputation damage** | Cold only from a separate warmed domain; SPF/DKIM/DMARC; `doctor` checks alignment; staged go-live with cold last |
| **Over-mailing a small UK market** | Governor throttles; ≤34 cold/day; Tue–Thu windows; hard suppression check before *every* send |
| **Claude mis-classifies a reply as positive** → bad draft in front of Daniel | Confidence <0.8 → no auto action, escalate raw text; draft-and-approve means a human always sends |
| **HubSpot free-tier ceiling** (1,000 contacts / 2 users) | Track count each cycle, alert at 80%; `doctor` reports headroom |
| **Key-person dependency** — Daniel doesn't read alerts | ≤6 non-urgent alerts/day, batched; urgent alerts break through; daily digest with one-click send links; nothing silently rots (nightly decay makes staleness visible) |
| **Starting from ~0 inbound** (new finding) | Sequence reactivation + LinkedIn first; don't over-promise inbound in month 1 |
| **UK GDPR/PECR** on B2B cold | LIA documented; one-click unsubscribe every message; suppression honoured pre-send; sole-traders/partnerships flagged at import as needing consent; `docs/COMPLIANCE.md` for a qualified human to sanity-check |
| **Wrong HubSpot region settings** (new finding) | Fix currency→GBP, timezone→London before any writes |

---

## 6. Build sequence & estimates

| Phase | Scope | Est. |
|---|---|---|
| **0** | Discovery + plan (**this doc**) — **STOP for approval** | done |
| 1 | Scaffold, config, `.env`, SQLite schema, logging, `pnpm run cycle` | 1–2 d |
| 2 | HubSpot private app, schema provisioning, bidirectional sync + reconcile (test on 5 dummy contacts first) | 2–3 d |
| 3 | Four ingestion adapters + dedupe + validation reports | 3–4 d |
| 4 | Scoring engine, decay, band transitions, event log (**hard unit tests**) | 2–3 d |
| 5 | Sequence engine + copy generation + lint pass + Gmail drafts | 3–4 d |
| 6 | Reply polling, classification, routing, calendar booking | 2–3 d |
| 7 | Alerts (Slack + email), digests, governor | 2–3 d |
| 8 | Dashboard (`dashboard.html`) | 1–2 d |
| 9 | **Dry run — 14 days shadow mode** (not compressible) | 14 d elapsed |
| 10 | Staged go-live: reactivation → inbound → LinkedIn → cold (after ≥3 wks warming) | ongoing |

Build effort ≈ **3–4 focused weeks** before the dry run; the dry run and domain warming run partly in parallel.

---

## 7. Questions — status

**Resolved (see "Answers from Daniel" above):** form destination, approval hours, call hours, quotes location, project value, cold domain (not bought), Slack (recommendation below).

**Slack recommendation:** one channel **`#vedri-funnel`** for the daily digest, weekly pace report, and band-change notices; **urgent alerts** (new inbound, HOT lead, positive reply, deal won, system failure) also fire as a **direct DM** to Daniel so they break through the 6/day rate limit. Confirm the workspace and I'll wire it in Phase 7.

**Still genuinely open:**
1. **Capacity ceiling** — a real number of deliverable jobs/month per track (or a rule of thumb by scope). Without it the governor can't tell "behind pace" from "already full". *"Depends on scope" is fine as long as you give me a floor and a ceiling.*
2. **ICP corrections** — company size band (crew/turnover), sectors to exclude, Dublin/ROI in or out.
3. **HubSpot regional settings** — OK to fix currency→GBP and timezone→Europe/London? (You change it in HubSpot settings; I can't via API.)

### Original question list (for reference)

1. **Decision-matrix form** — where does the `vedri.studio` VP decision-matrix form submit to? (I only see the VFX form on `vfx.vedri.studio`.) Is it wired to `info@vedri.studio` yet?
2. **HubSpot regional settings** — OK for me to have you switch currency→GBP and timezone→Europe/London before we provision? (You must do this in HubSpot; the API can't.)
3. **Past clients & dead quotes** — where do they live (spreadsheet, Gmail, elsewhere)? Roughly how many, and how would you segment worked-with-us vs quoted-but-lost vs enquired-never-quoted?
4. **Weekly time budget** — realistically, how many hours/week can you give to (a) approving drafts and (b) taking discovery calls? This sets the max sustainable volume.
5. **Capacity ceiling** — how many jobs/month can the studio actually *deliver* per track? (A funnel that lands 4 into a studio that can run 2 is a worse problem than being behind.)
6. **Average project value** — a working figure per track (Studio vs VFX) for pipeline weighting and cost-per-close.
7. **Cold sending domain** — have you bought one yet (`vedri-studio.com` / `getvedri.com`)? If not, I'll spec DNS (SPF/DKIM/DMARC) for you to set up so warming can start day 1.
8. **Slack** — which workspace + channel/DM should alerts go to?
9. **ICP corrections** — company-size band, sectors to exclude, and is Dublin/ROI in scope?

---

## 8. Compliance note

This is engineering to a known standard (UK GDPR + PECR), **not legal advice.** `docs/COMPLIANCE.md` will hold the legitimate-interest assessment, suppression handling, and the specific points Daniel should get checked by someone qualified before cold sending begins. Sole traders / unincorporated partnerships are treated as individual subscribers (consent required) and flagged at import rather than mailed.
