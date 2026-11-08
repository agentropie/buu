import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const extensionDir = join(repoRoot, 'extension');

/** Chrome extension ID: first 32 hex chars of SHA-256 of the DER public key, mapped 0-f to a-p. */
export function extensionId(): string {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}
