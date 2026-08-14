/**
 * `pnpm run cycle` — the single entry point that runs one pass of the funnel.
 *
 * A cycle is the heartbeat: ingest → reconcile → score/decay → sequence/draft →
 * replies → governor → alerts → dashboard. Each step is isolated so a failure
 * in one is recorded and does not abort the rest, and every run is logged to the
 * cycle_runs table for the doctor and audit trail.
 *
 * Phase 1 wires the skeleton: DB opens + migrates, the run is recorded, and each
 * step is a placeholder that later phases replace. Nothing is sent and no live
 * system is touched — DRY_RUN and AUTO_SEND_FOLLOWUPS gate all of that when the
 * real steps land.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { log } from './logger.js';
import { db, closeDb } from './db/index.js';
import { syncHubSpot } from './hubspot/sync.js';
import { runIngest } from './ingest/index.js';
import { runScoring } from './scoring.js';
import { runSequences } from './sequences/engine.js';

const clog = log.child('cycle');

interface StepResult {
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  counts?: Record<string, number>;
  note?: string;
}

type Step = { name: string; run: () => Promise<StepResult> };

/**
 * The ordered pipeline. Each entry is a placeholder until its phase lands; the
 * `note` explains which phase implements it. Order matters: score before
 * sequence (so bands are current), governor before alerts (so recommendations
 * are included), dashboard last (so it reflects the whole cycle).
 */
const STEPS: Step[] = [
  {
    name: 'ingest',
    run: async () => {
      const s = await runIngest();
      return {
        name: 'ingest',
        status: 'ok',
        counts: { imported: s.imported, rejected: s.rejected, needsConsent: s.needsConsent },
      };
    },
  },
  {
    name: 'reconcile-hubspot',
    run: async () => {
      const s = await syncHubSpot();
      return {
        name: 'reconcile-hubspot',
        status: s.skipped ? 'skipped' : 'ok',
        counts: {
          reconciled: s.reconciled,
          created: s.created,
          wouldCreate: s.wouldCreate,
          wouldUpdate: s.wouldUpdate,
          humanOverrides: s.humanOverrides,
        },
        ...(s.skipped ? { note: 'HUBSPOT_PRIVATE_APP_TOKEN not set' } : {}),
      };
    },
  },
  {
    name: 'score-and-decay',
    run: async () => {
      const s = runScoring();
      return {
        name: 'score-and-decay',
        status: 'ok',
        counts: { scored: s.scored, bandChanges: s.bandChanges, hot: s.hot },
      };
    },
  },
  {
    name: 'sequence-and-draft',
    run: async () => {
      const s = await runSequences();
      return {
        name: 'sequence-and-draft',
        status: 'ok',
        counts: { drafted: s.generated, lintFailed: s.lintFailed, processed: s.processed },
      };
    },
  },
  step('replies', 'Phase 6: poll mailboxes, classify, route, book calls'),
  step('governor', 'Phase 7: project pace vs target, recommend volume changes'),
  step('alerts', 'Phase 7: send urgent alerts + batched digests'),
  step('dashboard', 'Phase 8: regenerate dashboard.html'),
];

/** Placeholder step factory — logs and reports skipped until its phase lands. */
function step(name: string, note: string): Step {
  return {
    name,
    run: async () => {
      clog.debug(`step '${name}' not yet implemented`, { note });
      return { name, status: 'skipped', note };
    },
  };
}

export async function runCycle(): Promise<{ ok: boolean; runId: string }> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  clog.info('Cycle starting', {
    runId,
    dryRun: config.dryRun,
    autoSend: config.autoSendFollowups,
    tz: config.timezone,
  });

  // Opening the DB runs migrations on first use.
  const conn = db();
  conn
    .prepare('INSERT INTO cycle_runs (id, started_at, status, dry_run) VALUES (?, ?, ?, ?)')
    .run(runId, startedAt, 'running', config.dryRun ? 1 : 0);

  const results: StepResult[] = [];
  let ok = true;

  for (const s of STEPS) {
    try {
      results.push(await s.run());
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      clog.error(`step '${s.name}' failed`, { error: message });
      results.push({ name: s.name, status: 'failed', note: message });
      // Continue: one bad step must not abort the whole cycle.
    }
  }

  const finishedAt = new Date().toISOString();
  conn
    .prepare('UPDATE cycle_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?')
    .run(finishedAt, ok ? 'ok' : 'failed', JSON.stringify(results), runId);

  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  clog.info('Cycle finished', {
    runId,
    ok,
    steps: results.length,
    skipped,
    failed,
    ms: Date.parse(finishedAt) - Date.parse(startedAt),
  });

  return { ok, runId };
}

// Run when invoked directly (pnpm run cycle).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain || import.meta.url === `file://${process.argv[1]}`) {
  runCycle()
    .then(({ ok }) => {
      closeDb();
      if (config.dryRun) {
        clog.info('Shadow mode: no emails sent, no HubSpot writes. This was a dry run.');
      }
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      clog.error('Cycle crashed', { error: err instanceof Error ? err.message : String(err) });
      closeDb();
      process.exit(1);
    });
}
