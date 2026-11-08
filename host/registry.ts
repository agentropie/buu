import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from './paths.ts';

export type RegistryEntry = {
  instanceId: string;
  pid: number;
  browser: string;
  socket: string;
  cdpBase: string; // ws://127.0.0.1:<port>/<secret>
  startedAt: number;
};

export function entryPath(instanceId: string): string {
  return join(runDir, `${instanceId}.json`);
}

export function socketPath(instanceId: string): string {
  return join(runDir, `${instanceId}.sock`);
}

export function writeEntry(entry: RegistryEntry): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = entryPath(entry.instanceId);
  writeFileSync(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readEntry(instanceId: string): RegistryEntry | undefined {
  try {
    return JSON.parse(readFileSync(entryPath(instanceId), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Delete our files, but only if a newer host has not replaced them. */
export function removeEntryIfOwned(instanceId: string, pid: number): void {
  const cur = readEntry(instanceId);
  if (!cur || cur.pid !== pid) return;
  for (const f of [entryPath(instanceId), socketPath(instanceId)]) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Entries whose host process is alive. Stale ones are returned separately. */
export function listEntries(): { live: RegistryEntry[]; stale: RegistryEntry[] } {
  const live: RegistryEntry[] = [];
  const stale: RegistryEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(runDir).filter((n) => n.endsWith('.json'));
  } catch {}
  for (const n of names) {
    try {
      const e = JSON.parse(readFileSync(join(runDir, n), 'utf8')) as RegistryEntry;
      (pidAlive(e.pid) ? live : stale).push(e);
    } catch {}
  }
  return { live, stale };
}
