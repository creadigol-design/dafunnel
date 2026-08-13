/**
 * SQLite connection + migration runner.
 *
 * Opens (and creates on first run) the database at config.paths.db, enables
 * WAL + foreign keys, and applies any pending migrations inside a transaction.
 * A single shared connection is exported via `db()`.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { MIGRATIONS } from './schema.js';

let instance: Database.Database | null = null;

/** Get the shared DB connection, opening + migrating it on first call. */
export function db(): Database.Database {
  if (instance) return instance;

  mkdirSync(dirname(config.paths.db), { recursive: true });
  const conn = new Database(config.paths.db);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');

  migrate(conn);
  instance = conn;
  return conn;
}

/** Apply migrations above the current user_version, transactionally. */
function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number;
  const target = MIGRATIONS.length;
  if (current >= target) return;

  log.info('Applying database migrations', { from: current, to: target });
  const run = conn.transaction(() => {
    for (let v = current; v < target; v++) {
      conn.exec(MIGRATIONS[v]!);
    }
    conn.pragma(`user_version = ${target}`);
  });
  run();
  log.info('Migrations applied', { version: target });
}

/** Close the connection (used by scripts/tests). */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Read a sync_state value. */
export function getSyncState(key: string): string | null {
  const row = db().prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Upsert a sync_state value. */
export function setSyncState(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}
