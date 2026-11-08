import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_NAME, wrapperPath } from '../host/paths.ts';
import { listEntries } from '../host/registry.ts';
import { request } from './client.ts';
import { extensionId, repoRoot } from './ext-id.ts';
import { manifestDirs } from './install.ts';

type Check = { ok: boolean; label: string; fix?: string; note?: boolean };

export async function doctor(userDataDir?: string): Promise<{ text: string; failed: boolean }> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string, fix?: string) => checks.push({ ok, label, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24, `node ${process.versions.node} runs TypeScript directly`, 'Install Node 24 or newer.');

  add(existsSync(join(repoRoot, 'node_modules', 'playwright-core')), 'dependencies installed', `Run: cd ${repoRoot} && npm install`);

  let wrapper = '';
  try {
    wrapper = readFileSync(wrapperPath, 'utf8');
    accessSync(wrapperPath, constants.X_OK);
    add(true, `host wrapper ${wrapperPath}`);
  } catch {
    add(false, `host wrapper ${wrapperPath}`, 'Run: buu install');
  }
  if (wrapper) {
    const m = /^exec "([^"]+)" "([^"]+)"/m.exec(wrapper);
    add(!!m && existsSync(m[1]), 'wrapper node path exists', 'Run: buu install (it writes the node path again)');
    add(!!m && existsSync(m[2]), 'wrapper points to host/main.ts', 'Run: buu install');
  }

  const id = extensionId();
  for (const dir of manifestDirs(userDataDir)) {
    const file = join(dir, `${HOST_NAME}.json`);
    let m: any;
    try {
      m = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      add(false, `host manifest ${file}`, userDataDir ? `Run: buu install --user-data-dir ${userDataDir}` : 'Run: buu install');
      continue;
    }
    add(m.path === wrapperPath, `host manifest ${file} points to the wrapper`, 'Run: buu install');
    add(
      Array.isArray(m.allowed_origins) && m.allowed_origins.includes(`chrome-extension://${id}/`),
      'host manifest allows the buu extension id',
      'Run: buu install',
    );
  }

  const { live, stale } = listEntries();
  for (const e of stale) {
    add(false, `stale registry entry ${e.instanceId} (${e.browser}, pid ${e.pid} is dead)`, `Run: rm "${e.socket.replace(/\.sock$/, '.json')}" "${e.socket}"`);
  }
  for (const e of live) {
    try {
      const r = await request(e, { cmd: 'ping' }, 3000);
      add(r.ok, `browser ${e.browser} (pid ${e.pid}) answers on its socket`, `Reload the buu extension in ${e.browser}.`);
    } catch (err) {
      add(false, `browser ${e.browser} (pid ${e.pid}) answers on its socket`, `${(err as Error).message}. Reload the buu extension in ${e.browser}.`);
    }
  }
  if (!live.length && !stale.length) {
    checks.push({ ok: true, note: true, label: 'no browser connected yet (load the extension: buu install prints the folder)' });
  }

  const lines = checks.map((c) => `${c.note ? '-' : c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n    fix: ${c.fix}`}`);
  return { text: lines.join('\n'), failed: checks.some((c) => !c.ok) };
}
