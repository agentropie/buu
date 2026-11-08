// buu native host. Chrome starts this through ~/.buu/bin/buu-host.
// stdout carries native messaging frames only. Logs go to ~/.buu/logs.
import { execFileSync } from 'node:child_process';
import { createLogger } from './log.ts';
import { ExtensionChannel } from './ext.ts';
import { Hub } from './hub.ts';
import { Relay } from './relay.ts';
import { startServer } from './server.ts';
import { removeEntryIfOwned, socketPath, writeEntry, listEntries } from './registry.ts';
import { unlinkSync } from 'node:fs';
import { entryPath } from './registry.ts';

function parentBrowserName(): string {
  try {
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim();
    const app = /([^/]+)\.app\//.exec(comm)?.[1] ?? comm.split('/').pop() ?? 'unknown';
    return (
      app
        .toLowerCase()
        .replace(/^google /, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

const browser = parentBrowserName();
const log = createLogger(browser);
log(`host start, browser=${browser}, ppid=${process.ppid}, argv=${process.argv.slice(2).join(' ')}`);

// Console output would corrupt the native messaging stream.
for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) console[k] = (...a: unknown[]) => log(...a);
process.on('uncaughtException', (e) => {
  log('uncaughtException', e);
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection', e);
});

const ext = new ExtensionChannel(process.stdin, process.stdout);
ext.on('error-log', (e) => log('channel error', e));
const hub = new Hub(ext, log);

let instanceId = '';
function cleanupAndExit(code = 0) {
  hub.shutdown();
  if (instanceId) removeEntryIfOwned(instanceId, process.pid);
  process.exit(code);
}
ext.on('close', () => {
  log('native port closed, exiting');
  cleanupAndExit(0);
});
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));

try {
  const info = await ext.call('getInfo');
  instanceId = info.instanceId;
  hub.userAgent = info.userAgent;
  hub.chromeVersion = /Chrome\/([\d.]+)/.exec(info.userAgent)?.[1] ?? '0.0.0.0';
  hub.restore(info.sessions ?? {});

  // Drop registry files of dead hosts.
  for (const e of listEntries().stale) {
    for (const f of [entryPath(e.instanceId), socketPath(e.instanceId)]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }

  const relay = new Relay(hub);
  await relay.listen();
  hub.relayBase = relay.base;

  const sock = socketPath(instanceId);
  const describe = () => ({
    instanceId,
    browser,
    pid: process.pid,
    extensionVersion: info.extensionVersion,
    userAgent: info.userAgent,
  });
  await startServer(hub, sock, describe);
  writeEntry({ instanceId, pid: process.pid, browser, socket: sock, cdpBase: relay.base, startedAt: Date.now() });
  log(`ready, instance=${instanceId}, socket=${sock}, relay port=${relay.port}`);
} catch (e) {
  log('startup failed', e);
  cleanupAndExit(1);
}
