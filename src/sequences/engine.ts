/**
 * Sequence engine — walk due leads through their sequence, one touch per run.
 *
 * For each eligible lead: pick its sequence (track + source), if the current
 * step is due, generate + lint + persist a draft, then schedule the next step
 * into a valid send window. Halts naturally at the last step.
 *
 * Guards, in order: suppressed / terminal leads are skipped; a cold sequence is
 * skipped for consent-required (freemail/individual) leads; the suppression list
 * is checked before generating; only sequences in config.sequences.active run
 * (staged go-live). A per-run limit bounds API cost.
 */
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { allLeads, saveLead } from '../db/leads.js';
import { isTerminal } from '../scoring.js';
import { generateDraft, type StepSpec } from '../copy/generate.js';
import { persistDraft } from '../mail/draft-store.js';
import { selectSequence } from './load.js';
import { snapToSendWindow } from './schedule.js';

const elog = log.child('sequences');

export interface SequenceRunSummary {
  generated: number;
  lintFailed: number;
  processed: number;
}

function isSuppressed(email: string): boolean {
  return Boolean(db().prepare('SELECT 1 FROM suppression WHERE email = ?').get(email.toLowerCase()));
}

export async function runSequences(
  asOf: Date = new Date(),
  opts: { limit?: number } = {},
): Promise<SequenceRunSummary> {
  const active = new Set(config.sequences.active);
  const limit = opts.limit ?? config.sequences.perCycleLimit;
  const summary: SequenceRunSummary = { generated: 0, lintFailed: 0, processed: 0 };

  for (const lead of allLeads()) {
    if (summary.processed >= limit) break;
    if (lead.suppressed || isTerminal(lead.temperature)) continue;

    const seq = selectSequence(lead, undefined, active);
    if (!seq || !active.has(seq.id)) continue;
    if (seq.cold && lead.needsConsent) continue; // cold needs consent — skip
    if (isSuppressed(lead.email)) continue;

    const step = lead.sequenceStep ?? 0;
    if (step >= seq.steps.length) continue; // sequence complete

    // Due? A started sequence with a future next-touch isn't due yet.
    if (lead.sequenceId === seq.id && lead.nextTouchAt && Date.parse(lead.nextTouchAt) > asOf.getTime()) {
      continue;
    }

    const stepDef = seq.steps[step]!;
    const spec: StepSpec = {
      sequenceId: seq.id,
      stepIndex: step,
      purpose: stepDef.purpose,
      guidance: stepDef.guidance,
    };

    const gen = await generateDraft(lead, spec);
    await persistDraft(lead, seq.id, step, seq.fromMailbox, gen);
    summary.processed++;
    if (gen.lint.pass) summary.generated++;
    else summary.lintFailed++;

    // Schedule the next step into a valid send window.
    const nextStep = step + 1;
    let nextTouchAt: string | null = null;
    if (nextStep < seq.steps.length) {
      const deltaDays = seq.steps[nextStep]!.dayOffset - stepDef.dayOffset;
      nextTouchAt = snapToSendWindow(new Date(asOf.getTime() + deltaDays * 86_400_000)).toISOString();
    }
    saveLead({
      ...lead,
      sequenceId: seq.id,
      sequenceStep: nextStep,
      nextTouchAt,
      updatedAt: asOf.toISOString(),
    });
  }

  elog.info('sequence run complete', { ...summary });
  return summary;
}
