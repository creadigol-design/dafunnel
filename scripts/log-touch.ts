/**
 * `pnpm run log-touch` — log a LinkedIn/social DM or connection.
 *
 * Example:
 *   pnpm run log-touch -- --email jo@prodco.co.uk --name "Jo Rhys" \
 *     --company ProdCo --note "Connected, mentioned their green-screen series" --days 4
 */
import { logTouch } from '../src/ingest/social.js';
import { closeDb } from '../src/db/index.js';
import type { Track } from '../src/types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = flag('email');
const note = flag('note');
if (!email || !note) {
  console.error('Usage: pnpm run log-touch -- --email <email> --note "<what happened>" [--name ..] [--company ..] [--track Studio|VFX] [--days 4]');
  process.exit(2);
}

const trackArg = flag('track');
const track = trackArg === 'Studio' || trackArg === 'VFX' ? (trackArg as Track) : undefined;

const res = logTouch({
  email,
  note,
  name: flag('name'),
  company: flag('company'),
  track,
  followUpDays: flag('days') ? Number(flag('days')) : undefined,
});
closeDb();
console.log(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`);
process.exit(res.ok ? 0 : 1);
