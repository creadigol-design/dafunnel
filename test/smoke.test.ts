/**
 * Phase 1 smoke test: the scaffold stands up and the audit trail round-trips.
 *
 * Uses a throwaway DB via DB_PATH so it never touches the real data file.
 * (Set before importing any module that reads config, since config freezes at
 * import time.) The heavy state-machine tests land in Phase 4.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vedri-test-'));
process.env.DB_PATH = join(tmp, 'test.db');
process.env.LOG_DIR = join(tmp, 'logs');
process.env.DRY_RUN = 'true';

// Dynamic imports so the env above is in place before config loads.
const { db, closeDb } = await import('../src/db/index.js');
const { recordEvent, eventsForLead } = await import('../src/db/events.js');
const { runCycle } = await import('../src/cycle.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('database + migrations', () => {
  beforeAll(() => db());

  it('creates all core tables', () => {
    const names = db()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['leads', 'events', 'suppression', 'drafts', 'alerts_log', 'cycle_runs', 'sync_state']) {
      expect(names).toContain(t);
    }
  });

  it('sets the schema version', () => {
    expect(db().pragma('user_version', { simple: true })).toBe(1);
  });
});

describe('append-only event log', () => {
  it('records and reads back an event with a score delta', () => {
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO leads (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run('lead-1', 'test@example.com', now, now);

    recordEvent({
      leadId: 'lead-1',
      type: 'score.changed',
      trigger: 'unit-test',
      oldScore: 0,
      newScore: 35,
      reason: 'positive reply',
    });

    const events = eventsForLead('lead-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.newScore).toBe(35);
    expect(events[0]!.reason).toBe('positive reply');
  });
});

describe('cycle entry point', () => {
  it('runs a full dry-run cycle and records it', async () => {
    const { ok, runId } = await runCycle();
    expect(ok).toBe(true);

    const row = db().prepare('SELECT * FROM cycle_runs WHERE id = ?').get(runId) as {
      status: string;
      dry_run: number;
    };
    expect(row.status).toBe('ok');
    expect(row.dry_run).toBe(1);
  });
});
