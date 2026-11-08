import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from './paths.ts';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type Logger = (...args: unknown[]) => void;

/** Append-only file logger. stdout belongs to native messaging, so we never print there. */
export function createLogger(name: string): Logger {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = join(logDir, `host-${name}.log`);
  try {
    if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0);
  } catch {}
  return (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(' ');
    try {
      appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {}
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
