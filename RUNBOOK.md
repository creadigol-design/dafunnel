# RUNBOOK — when it breaks, at 7am, with a shoot that day

You have a shoot. You do not have time to debug. Do these in order.

## 0. The three kill switches (fastest first)

| You want | Do this | Effect |
|---|---|---|
| **Stop emails sending** | In `.env` set `AUTO_SEND_FOLLOWUPS=false` | Already the default. Drafts still appear; nothing leaves without you |
| **Stop everything touching the world** | In `.env` set `DRY_RUN=true` | Engine still computes; no sends, no HubSpot writes. Safe to leave on for weeks |
| **Full stop** | `crontab -e` → put `#` in front of both vedrí lines | Engine goes dormant. Nothing runs at all |

None of these lose data. The event log and drafts are all still there when you come back.

## 1. "Is it actually broken?" — 60-second triage

SSH to the VPS, then:

```bash
cd ~/vedri-funnel
pnpm run doctor          # green ticks = fine, go to your shoot
tail -50 output/logs/cron.log   # what happened on the last cycle
```

The doctor tells you: safety-flag state, database health, last cycle result,
suppression list, credential presence, HubSpot contact count, drafts pending.
**If the doctor is green and the last cycle says `"ok":true`, nothing is broken** —
whatever you saw in Slack was informational.

## 2. Common failures and the fix

| Symptom | Cause | Fix |
|---|---|---|
| Slack alert: *system failure / cycle failed* | One step threw twice running | `tail -100 output/logs/cron.log`, find the `"level":"error"` line — the module name tells you which section below applies |
| `HubSpot … 401` in logs | Private-app token revoked/regenerated | HubSpot → Settings → Private Apps → vedrí Funnel Engine → copy token → paste into `.env` `HUBSPOT_PRIVATE_APP_TOKEN` |
| `HubSpot … 403 MISSING_SCOPES` | Scope removed | Same page → Scopes tab → the error names the missing scope → add, save |
| `IMAP connect failed` / `invalid credentials` | Mailbox password changed, or host blocking | Check `MAIL_PASS` in `.env`; test with `pnpm run mail-doctor`; if the host moved servers, update `MAIL_HOST` |
| `invalid_auth` from Slack | Bot token rotated (app reinstalled) | api.slack.com/apps → vedrí funnel → OAuth & Permissions → copy the current `xoxb-` token → `.env` |
| Anthropic `401` / `credit` errors | Key revoked or credits out | console.anthropic.com → Billing (top up) or API Keys (new key → `.env`) |
| Drafts all `FLAGGED_` | Lint failing — usually a `{{NEEDS_INPUT}}` | Open the flagged file in `output/drafts/` — the first line says exactly which rule failed |
| Nothing ran overnight | Cron lost (VPS rebuilt/rebooted oddly) | `crontab -l` should show two vedrí lines; if empty re-run `bash deploy/setup-vps.sh` |
| "no space left on device" | Logs grew | `rm output/logs/*.log` — everything important is in the database, logs are disposable |

After any `.env` change: no restart needed — the next cron cycle picks it up. To
force one now: `pnpm run cycle`.

## 3. "Why did it email / not email this person?"

```bash
pnpm run explain their@email.com
```

Full event history: every import, score change, band move, draft, halt and the
reason string for each. This answers 95% of "why" questions.

## 4. Something sent that shouldn't have

1. `.env` → `DRY_RUN=true` (stops the world).
2. `pnpm run explain <email>` — the event log shows exactly what was sent and why.
3. If they must never be contacted again:
   ```bash
   sqlite3 data/vedri-funnel.db "INSERT OR IGNORE INTO suppression (email, reason, source, created_at) VALUES ('their@email.com','manual','runbook',datetime('now'));"
   ```
   Suppression is checked before every send, permanently.

## 4a. The prospector (finding NEW companies)

The prospector runs weekly inside the cycle: Claude with live web search hunts
UK/Ireland production companies, agencies and post houses matching the ICP,
each with a source link backing the "why it fits" claim. Candidates land in
the portal under **/prospects** — nothing is contacted until you approve one
there (approving needs a contact email; find it via their site or contact page
and paste it in). Binning a company is permanent — it is never suggested again.

- Run one now: `pnpm run prospect`
- Approved candidates become **Built List** leads. They only enter sequencing
  when a matching sequence (A1/A2/B1/B2) is in `SEQUENCES_ACTIVE` — so during
  the shadow fortnight they just sit as leads, safe.

## 4b. Copy sounds wrong / needs re-doing

After any copy-rule or sequence-guidance change, regenerate the entire unsent
queue in one command:

```bash
pnpm run redraft
```

Deletes every pending/flagged draft (sent and approved are untouched), rewinds
each lead's sequence to the discarded step, and regenerates immediately under
the current rules. Review in the portal as usual.

## 5. Moving / rebuilding the VPS

Everything that matters is three things: this repo, `.env`, and
`data/vedri-funnel.db`. Copy those to the new box, run
`bash deploy/setup-vps.sh`, done. (HubSpot holds a full copy of the leads too —
the local DB re-reconciles on the first cycle.)

## 6. Updating the code

```bash
cd ~/vedri-funnel && git pull && pnpm install --frozen-lockfile && pnpm test && pnpm run cycle
```

If tests fail, stop and don't run the cycle — the previous version keeps running
from cron untouched.
