import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOST_NAME, binDir, wrapperPath } from '../host/paths.ts';
import { extensionDir, extensionId, repoRoot } from './ext-id.ts';

const SUPPORT = join(homedir(), 'Library', 'Application Support');
// [label, browser data dir relative to Application Support]. Chrome is always installed (Dia reads it too).
export const BROWSER_DIRS: [string, string][] = [
  ['Chrome', 'Google/Chrome'],
  ['Chrome Beta', 'Google/Chrome Beta'],
  ['Chromium', 'Chromium'],
  ['Brave', 'BraveSoftware/Brave-Browser'],
  ['Edge', 'Microsoft Edge'],
];

export function manifestDirs(userDataDir?: string): string[] {
  if (userDataDir) return [join(userDataDir, 'NativeMessagingHosts')];
  return BROWSER_DIRS.filter(([label, rel]) => label === 'Chrome' || existsSync(join(SUPPORT, rel))).map(([, rel]) =>
    join(SUPPORT, rel, 'NativeMessagingHosts'),
  );
}

export function wrapperScript(): string {
  // Chrome starts hosts with a minimal PATH, so the node path must be absolute and stable (not an fnm shim dir).
  const node = realpathSync(process.execPath);
  return `#!/bin/sh\nexec "${node}" "${join(repoRoot, 'host', 'main.ts')}" "$@"\n`;
}

export function hostManifest(): object {
  return {
    name: HOST_NAME,
    description: 'buu native host',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId()}/`],
  };
}

export function install(userDataDir?: string): string[] {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(wrapperPath, wrapperScript());
  chmodSync(wrapperPath, 0o755);
  const written: string[] = [];
  for (const dir of manifestDirs(userDataDir)) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${HOST_NAME}.json`);
    writeFileSync(file, JSON.stringify(hostManifest(), null, 2) + '\n');
    written.push(file);
  }
  return written;
}

export function installReport(userDataDir?: string): string {
  const written = install(userDataDir);
  return [
    `host wrapper: ${wrapperPath}`,
    ...written.map((f) => `host manifest: ${f}`),
    `extension id: ${extensionId()}`,
    '',
    `Load unpacked: ${extensionDir}`,
    'Open chrome://extensions, turn on Developer mode, click "Load unpacked", pick that folder.',
  ].join('\n');
}
