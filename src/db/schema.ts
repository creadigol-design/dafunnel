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

export const SCHEMA_VERSION = 6;

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

  // ── v2: prospector — web-search-discovered candidates awaiting review ─────
  // Candidates are NOT leads: nothing contacts them, scores them or syncs them
  // to HubSpot until Daniel approves one in the viewer (which creates a
  // Built List lead). Discard is terminal but kept, so a discarded company is
  // never re-suggested (the domain stays in the dedupe set).
  `
  CREATE TABLE IF NOT EXISTS prospects (
    id               TEXT PRIMARY KEY,
    company          TEXT NOT NULL,
    website          TEXT,
    domain           TEXT,          -- normalised; dedupe key vs leads + prospects
    location         TEXT,
    category         TEXT,          -- prodco | agency | post house | brand studio | other
    track            TEXT NOT NULL DEFAULT 'Both',
    why_fit          TEXT,          -- one-line ICP-fit reason
    evidence_url     TEXT NOT NULL, -- source page backing the why_fit claim
    contact_name     TEXT,
    contact_email    TEXT,
    contact_page_url TEXT,
    status           TEXT NOT NULL DEFAULT 'candidate',  -- candidate|approved|discarded
    lead_id          TEXT,          -- set when approved → the created lead
    discovered_at    TEXT NOT NULL,
    reviewed_at      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain);
  CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
  `,

  // ── v3: prospect contact enrichment — who to pitch, with published evidence ─
  // contact_source_url records WHERE the name/email was published (the honesty
  // rule); enriched_at marks a candidate as looked-up so an empty result is not
  // re-searched every run.
  `
  ALTER TABLE prospects ADD COLUMN contact_role TEXT;
  ALTER TABLE prospects ADD COLUMN contact_source_url TEXT;
  ALTER TABLE prospects ADD COLUMN enriched_at TEXT;
  `,

  // ── v4: where a prospect came from — the weekly hunt or Instagram intake ──
  // 'instagram' rows start as a bare handle Daniel pasted from vedri.studio's
  // engagement; enrichment researches who they actually are.
  `
  ALTER TABLE prospects ADD COLUMN origin TEXT NOT NULL DEFAULT 'prospector';
  `,

  // ── v5: Instagram DM assist — drafted DMs Daniel sends by hand ────────────
  // The system writes and tracks; only Daniel's own thumb ever sends (DM
  // automation gets Instagram accounts banned). Status walks
  // none → drafted → sent → follow_up_due → sent … capped at ig_dm_count 2,
  // then 'done'; 'replied' at any point hands over to the approve flow.
  `
  ALTER TABLE prospects ADD COLUMN ig_dm TEXT;
  ALTER TABLE prospects ADD COLUMN ig_dm_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE prospects ADD COLUMN ig_dm_sent_at TEXT;
  ALTER TABLE prospects ADD COLUMN ig_dm_count INTEGER NOT NULL DEFAULT 0;
  `,

  // ── v6: discovered Instagram handles — published ones only, never guessed ─
  // Set by discovery/enrichment when a prospect's Instagram is found on public
  // pages. Any prospect with a handle gets the DM assist, both tracks.
  `
  ALTER TABLE prospects ADD COLUMN ig_handle TEXT;
  `,
];
