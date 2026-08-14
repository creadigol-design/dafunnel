/**
 * Load + select sequences. YAML files in sequences/ are parsed once and matched
 * to a lead by track + source. Track "Both" leads default to the Studio track.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Lead } from '../types.js';
import { validateSequence, type Sequence } from './schema.js';

const SEQUENCES_DIR = 'sequences';

let cache: Sequence[] | null = null;

export function loadSequences(): Sequence[] {
  if (cache) return cache;
  const files = readdirSync(SEQUENCES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  cache = files.map((f) => validateSequence(parse(readFileSync(join(SEQUENCES_DIR, f), 'utf8')), f));
  return cache;
}

/** Pick the sequence for a lead by track + source. Returns null if none matches. */
export function selectSequence(lead: Lead, sequences = loadSequences()): Sequence | null {
  const track = lead.track === 'VFX' ? 'VFX' : 'Studio'; // "Both" → Studio default
  const matches = sequences.filter((s) => s.track === track && s.sources.includes(lead.source));
  return matches[0] ?? null;
}
