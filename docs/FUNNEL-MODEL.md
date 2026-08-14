# FUNNEL-MODEL — the maths, the assumptions, and how actuals replace them

**The target: 2 closed jobs per month, combined across both tracks.**

But the real constraint is capacity: **~25 delivery-days/month** — one big job
(~25 shoot days) *or* two small jobs (~7 days each). Crew is elastic (roster),
so Daniel's time and stage-days bind, not headcount. A single £20k 25-day job
fills the month while counting as one close, so the governor thinks in
**delivery-days and value**, with "2 closes" as the plain-English proxy.
Project value band: **£7,000–£20,000** (midpoint ≈ £13.5k → target ≈ £27k/mo).

## Per-channel conversion assumptions (DEFAULTS)

Every number below is an assumption, not a fact. They live in
`config/funnel-model.ts` and are replaced by observed rates once enough real
evidence exists (see "Actuals" below).

| Channel | Contact→Reply | Reply→Interested | Interested→Call | Call→Proposal | Proposal→Won | Net |
|---|---|---|---|---|---|---|
| Inbound (site form / decision matrix) | — | — | 45% | 75% | 40% | **13.5%** |
| Reactivation (past clients, old quotes) | 25% | 55% | 40% | 70% | 45% | **1.7%** |
| Cold outbound (built lists) | 8% | 30% | 55% | 65% | 30% | **0.26%** |
| LinkedIn (manual — Daniel's channel) | 18% | 45% | 50% | 65% | 35% | **0.9%** |

## The blended monthly plan

| Channel | Volume in | Expected closes |
|---|---|---|
| Inbound | ~8 qualified enquiries | ≈ 1.1 |
| Reactivation | ~15 contacts worked | ≈ 0.25 |
| LinkedIn (manual) | ~35 conversations | ≈ 0.3 |
| Cold | ~150 new contacts | ≈ 0.4 |
| **Total** | | **≈ 2.0** |

- Cold: 150 contacts × ~5 touches ≈ 750 emails/month ≈ **34/working day** —
  under mailbox limits, personalisable, and low enough not to burn the small UK
  production market.
- **LinkedIn is not system-managed.** It is Daniel's personal relationship
  channel; the system never ingests, drafts, or schedules there. Its closes
  still count toward the target; if its contribution dips the governor
  compensates with the managed channels, never by automating LinkedIn.
- **Starting reality (Aug 2026):** inbound is ~0 (forms are new), so months 1–2
  lean on reactivation — which converts ~6× better than cold and costs nothing.
  Cold goes last, after the sending domain has warmed ≥3 weeks.

## Band-based projection (what the governor actually computes today)

Deals with stage-by-stage history don't exist yet, so v1 projects month-end
closes from lead temperature bands:

```
projected = closes_so_far + Hot×0.35 + Warm×0.10 + Cold×0.01 + Nurture×0.005
```

Those band probabilities are assumptions derived from the tables above and are
labelled as such in every governor message.

**Governor rules** (runs 1st + 15th, or forced):
- projected **< 2.0** → *behind*: name the gap, the cold volume that would close
  it (≈375 contacts per extra close), and point at warm conversions first.
- projected **> 3.0** → *over capacity*: recommend throttling and considering a
  price rise instead of volume.
- **It never changes volume itself.** Every recommendation is a reasoned Slack
  alert; the knobs (`SEQUENCES_ACTIVE`, `SEQUENCES_PER_CYCLE`) stay human.

## Actuals — how assumptions get replaced

The governor counts **genuine funnel evidence only**: classified replies and
real engagement signals. Warm-start seeding and imported history do *not* count
(the system must not grade itself on data it invented).

- **< 30 data points:** defaults used; every message says
  "Using DEFAULT conversion assumptions (n/30)".
- **≥ 30 data points:** observed rates over a rolling 90-day window take over,
  recomputed on each governor run — reply rate, interested rate, call-booking
  rate per channel — and the same thresholds apply to the recomputed projection.
  Stage-level actuals (call→proposal→won) activate as deals accumulate history.

When a stage's actual diverges badly from its assumption, that *is* the
diagnosis: e.g. "replies are healthy at 9% but only 2 of 11 interested leads
booked a call — the call-booking ask is the problem, not volume."

## Scoring model (the temperature spine)

`score = clamp( Σ positive signals − 3 × full_weeks_since_last_engagement )`

Bands: Cold 0–24 · Warm 25–54 · Hot 55–100, plus terminal Closed Won/Lost,
Suppressed, Disqualified and sticky Nurture (floor 15, 90-day quiet). The full
signal table is in `src/scoring.ts`; warm-start seeding for reactivation leads
(Negotiating +52 … Initial reach-out +18) is in `src/ingest/csv-import.ts`.
