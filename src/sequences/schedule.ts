/**
 * Send-window scheduling. Touches only go out Tue–Thu in the configured windows
 * (highest open rates for production people; avoids Monday triage / Friday wrap).
 * This snaps a target date forward to the next valid send slot.
 */
import { config } from '../../config/index.js';

/** Next allowed send slot on/after `from` (Tue–Thu, at the first window start). */
export function snapToSendWindow(from: Date): Date {
  const [h, m] = (config.sending.windows[0]?.start ?? '09:00').split(':').map(Number);
  const d = new Date(from);
  d.setUTCHours(h ?? 9, m ?? 0, 0, 0);
  if (d.getTime() < from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  let guard = 0;
  while (!config.sending.days.includes(d.getUTCDay()) && guard++ < 14) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}
