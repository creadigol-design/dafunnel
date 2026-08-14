/**
 * Sequence schema. Sequences are declared in sequences/*.yaml so Daniel can edit
 * copy intent + timing without touching code. The engine matches a lead to a
 * sequence by track + source, then walks its steps on the configured cadence.
 */
import type { Track, LeadSource, Mailbox } from '../types.js';

export interface SequenceStep {
  /** Days after sequence start this step is due. */
  dayOffset: number;
  purpose: string;
  guidance: string;
  /** Conditions that end the sequence early (informational; reply always halts). */
  exitConditions?: string[];
}

export interface Sequence {
  id: string;
  track: Track;
  /** Lead sources this sequence serves. */
  sources: LeadSource[];
  fromMailbox: Mailbox;
  /** Whether cold-consent rules apply (freemail/individual leads are skipped). */
  cold: boolean;
  steps: SequenceStep[];
}

export function validateSequence(s: unknown, file: string): Sequence {
  const seq = s as Partial<Sequence>;
  if (!seq.id || !seq.track || !Array.isArray(seq.sources) || !Array.isArray(seq.steps)) {
    throw new Error(`Invalid sequence in ${file}: missing id/track/sources/steps`);
  }
  if (seq.steps.length === 0) throw new Error(`Sequence ${seq.id} has no steps`);
  return seq as Sequence;
}
