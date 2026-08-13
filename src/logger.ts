/**
 * Structured logging. Emits single-line JSON to stdout (greppable, machine
 * parseable) and appends the same lines to a dated file under LOG_DIR so a
 * cycle that ran unattended at 07:00 can be reconstructed after the fact.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;

function logFilePath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(config.paths.logs, `${day}.log`);
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(config.dryRun ? { dryRun: true } : {}),
    ...fields,
  });

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');

  try {
    mkdirSync(config.paths.logs, { recursive: true });
    appendFileSync(logFilePath(), line + '\n');
  } catch {
    // Never let logging failure crash the cycle.
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  /** Scoped child logger that prefixes a module name onto every line. */
  child: (module: string) => ({
    debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, { module, ...f }),
    info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, { module, ...f }),
    warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, { module, ...f }),
    error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, { module, ...f }),
  }),
};
