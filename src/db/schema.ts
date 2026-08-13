/**
 * SQLite schema — the local state + audit mirror.
 *
 * SQLite is our source of truth for machine-owned fields and the append-only
 * audit trail, so the system keeps working if HubSpot is unreachable and
 * reconciles on the next cycle. HubSpot wins on human-edited fields; we win on
 * machine fields.
 *
 * Migrations are versioned via PRAGMA user_version. To evolve the schema, add a
 * new entry to MIGRATIONS with the next integer version — never edit an applied
 * one. `migrate()` in ./index.ts applies everything above the current version
 * in a single transaction.
 */

export const SCHEMA_VERSION = 1;

/** Ordered migrations. Index+1 is the version each statement block moves TO. */
export const MIGRATIONS: string[] = [
  // ── v1: initial schema ──────────────────────────────────────────────────
  `
  -- Leads: machine-owned mirror of HubSpot contacts. Dedupe on (email, company_domain).
  CREATE TABLE IF NOT EXISTS leads (
    id                    TEXT PRIMARY KEY,
    email                 TEXT NOT NULL,
    company_domain        TEXT,
    first_name            TEXT,
    last_name             TEXT,
    company               TEXT,
    track                 TEXT NOT NULL DEFAULT 'Both',
    source                TEXT NOT NULL DEFAULT 'Other',
    temperature           TEXT NOT NULL DEFAULT 'Cold',
    score                 INTEGER NOT NULL DEFAULT 0,
    icp_fit               TEXT,
    recommended_approach  TEXT,
    internal_notes        TEXT,          -- kit list / quiz answers; NEVER client-facing
    lia_basis             TEXT,          -- legitimate-interest record
    needs_input           TEXT,          -- unresolved {{NEEDS_INPUT}} tokens
    needs_consent         INTEGER NOT NULL DEFAULT 0,  -- sole trader / partnership flag
    suppressed            INTEGER NOT NULL DEFAULT 0,
    suppression_reason    TEXT,
    sequence_id           TEXT,
    sequence_step         INTEGER,
    next_touch_at         TEXT,
    last_engagement_at    TEXT,
    score_updated_at      TEXT,
    hubspot_contact_id    TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
  CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(company_domain);
  CREATE INDEX IF NOT EXISTS idx_leads_temperature ON leads(temperature);
  CREATE INDEX IF NOT EXISTS idx_leads_next_touch ON leads(next_touch_at);
  CREATE INDEX IF NOT EXISTS idx_leads_hubspot ON leads(hubspot_contact_id);

  -- Events: append-only audit log. Never UPDATE or DELETE rows here.
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    lead_id     TEXT,
    type        TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    old_score   INTEGER,
    new_score   INTEGER,
    reason      TEXT NOT NULL,
    data        TEXT,          -- JSON
    created_at  TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);

  -- Suppression: permanent do-not-contact. Checked before EVERY send.
  CREATE TABLE IF NOT EXISTS suppression (
    email       TEXT PRIMARY KEY,
    reason      TEXT NOT NULL,
    source      TEXT,
    created_at  TEXT NOT NULL
  );

  -- Drafts: generated outbound awaiting approval (or shadow-mode files).
  CREATE TABLE IF NOT EXISTS drafts (
    id           TEXT PRIMARY KEY,
    lead_id      TEXT,
    sequence_id  TEXT,
    step         INTEGER,
    mailbox      TEXT NOT NULL,         -- 'warm' | 'cold'
    subject      TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|sent|failed|lint_failed
    lint_status  TEXT,                  -- pass | fail:<reason>
    file_path    TEXT,                  -- set in DRY_RUN (output/drafts/…)
    gmail_draft_id TEXT,                -- set when a real Gmail draft exists
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
  CREATE INDEX IF NOT EXISTS idx_drafts_lead ON drafts(lead_id);

  -- Alerts log: what we told Daniel and when (for rate limiting + audit).
  CREATE TABLE IF NOT EXISTS alerts_log (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    urgency     TEXT NOT NULL,
    channel     TEXT NOT NULL,
    lead_id     TEXT,
    sent_at     TEXT NOT NULL,
    payload     TEXT              -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts_log(sent_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts_log(type, sent_at);

  -- Cycle runs: one row per \`pnpm run cycle\`, for the doctor + audit.
  CREATE TABLE IF NOT EXISTS cycle_runs (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',  -- running|ok|failed
    dry_run     INTEGER NOT NULL,
    summary     TEXT              -- JSON: per-step counts
  );
  CREATE INDEX IF NOT EXISTS idx_cycle_started ON cycle_runs(started_at);

  -- Sync state: reconciliation cursors + last-successful timestamps (key/value).
  CREATE TABLE IF NOT EXISTS sync_state (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `,
];
