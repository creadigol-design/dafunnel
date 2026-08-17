/**
 * `pnpm run redraft` — throw away every unsent draft and regenerate it under
 * the current copy rules.
 *
 * Use after a copy/voice change: deletes drafts with status pending or
 * lint_failed (sent/approved are never touched), removes their shadow-mode
 * files, rewinds each affected lead's sequence_step to the earliest discarded
 * step, then runs the sequence engine immediately so the queue refills in one
 * command. Safe to run repeatedly.
 */
import { unlinkSync } from 'node:fs';
import { db, closeDb } from '../src/db/index.js';
import { recordEvent } from '../src/db/events.js';
import { runSequences } from '../src/sequences/engine.js';

const conn = db();

const discardable = conn
  .prepare(
    `SELECT id, lead_id, sequence_id, step, file_path FROM drafts
     WHERE status IN ('pending', 'lint_failed')`,
  )
  .all() as { id: string; lead_id: string | null; sequence_id: string | null; step: number | null; file_path: string | null }[];

if (discardable.length === 0) {
  console.log('No pending drafts to redraft.');
  closeDb();
  process.exit(0);
}

// Earliest discarded step per lead — that's where the sequence rewinds to.
const rewindTo = new Map<string, number>();
for (const d of discardable) {
  if (!d.lead_id || d.step == null) continue;
  const cur = rewindTo.get(d.lead_id);
  if (cur === undefined || d.step < cur) rewindTo.set(d.lead_id, d.step);
}

const wipe = conn.transaction(() => {
  for (const d of discardable) {
    if (d.file_path) {
      try {
        unlinkSync(d.file_path);
      } catch {
        // Shadow file already gone — fine.
      }
    }
    conn.prepare('DELETE FROM drafts WHERE id = ?').run(d.id);
  }
  const now = new Date().toISOString();
  for (const [leadId, step] of rewindTo) {
    conn
      .prepare('UPDATE leads SET sequence_step = ?, next_touch_at = NULL, updated_at = ? WHERE id = ?')
      .run(step, now, leadId);
    recordEvent({
      leadId,
      type: 'draft.redrafted',
      trigger: 'redraft-script',
      reason: `Unsent drafts discarded; sequence rewound to step ${step + 1} for regeneration under current copy rules.`,
      data: { rewoundToStep: step },
    });
  }
});
wipe();

console.log(`Discarded ${discardable.length} unsent draft(s) across ${rewindTo.size} lead(s). Regenerating…`);

const s = await runSequences(new Date(), { limit: Math.max(rewindTo.size, 1) });
closeDb();

console.log(`\nRegenerated — processed ${s.processed}, drafts ready ${s.generated}, lint-flagged ${s.lintFailed}`);
console.log('Review them in the portal under /drafts.');
