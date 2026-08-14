/**
 * Persist a generated draft. In DRY_RUN, drafts are written to files under
 * output/drafts/ (shadow mode). Live, passing drafts are appended to the cPanel
 * Drafts folder over IMAP for Daniel to review and send. Lint-failed drafts are
 * always written to a file and flagged — never sent, never silently dropped.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { recordEvent } from '../db/events.js';
import type { Lead } from '../types.js';
import type { GeneratedDraft } from '../copy/generate.js';
import { saveDraftToMailbox } from './client.js';

const dlog = log.child('drafts');

export interface PersistedDraft {
  id: string;
  status: 'pending' | 'lint_failed';
  filePath: string | null;
}

function writeFile(name: string, contents: string): string {
  mkdirSync(config.paths.drafts, { recursive: true });
  const path = join(config.paths.drafts, name);
  writeFileSync(path, contents);
  return path;
}

export async function persistDraft(
  lead: Lead,
  sequenceId: string,
  stepIndex: number,
  mailbox: string,
  gen: GeneratedDraft,
): Promise<PersistedDraft> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const subject = gen.subjects[0] ?? '(no subject)';
  const status: PersistedDraft['status'] = gen.lint.pass ? 'pending' : 'lint_failed';
  const safeEmail = lead.email.replace(/[^a-z0-9]+/gi, '_');
  let filePath: string | null = null;

  const fileBody = [
    `Sequence: ${sequenceId}  ·  Step ${stepIndex + 1}  ·  Mailbox: ${mailbox}`,
    `To: ${lead.firstName ?? ''} <${lead.email}>  ·  ${lead.company ?? ''}`,
    `Temperature: ${lead.temperature} (${lead.score})`,
    gen.lint.pass ? 'LINT: PASS' : `LINT: FAIL — ${gen.lint.failures.join('; ')}`,
    `Subject options: ${gen.subjects.join('  |  ')}`,
    '',
    gen.rendered.full,
  ].join('\n');

  if (gen.lint.pass && !config.dryRun) {
    // Live: drop into the mailbox Drafts folder for human review + send.
    await saveDraftToMailbox(lead.email, subject, gen.rendered.full);
  } else {
    // Shadow mode, or a flagged draft: write a file so it's reviewable.
    const prefix = gen.lint.pass ? '' : 'FLAGGED_';
    filePath = writeFile(`${prefix}${sequenceId}_step${stepIndex + 1}_${safeEmail}.txt`, fileBody);
  }

  db()
    .prepare(
      `INSERT INTO drafts (id, lead_id, sequence_id, step, mailbox, subject, body, status, lint_status, file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, lead.id, sequenceId, stepIndex, mailbox, subject, gen.body, status,
      gen.lint.pass ? 'pass' : `fail: ${gen.lint.failures.join('; ')}`, filePath, now, now,
    );

  recordEvent({
    leadId: lead.id,
    type: gen.lint.pass ? 'draft.created' : 'draft.lint_failed',
    trigger: 'sequence-engine',
    reason: `${sequenceId} step ${stepIndex + 1}: ${gen.lint.pass ? 'draft ready' : 'lint failed — ' + gen.lint.failures.join('; ')}`,
    data: { sequenceId, step: stepIndex, mailbox },
  });
  dlog.info('draft persisted', { email: lead.email, sequenceId, step: stepIndex + 1, status });

  return { id, status, filePath };
}
