import { connect } from 'node:net';
import { FrameDecoder, encodeFrame } from '../host/frame.ts';
import { listEntries, type RegistryEntry } from '../host/registry.ts';
import type { Request, Response } from '../host/server.ts';

export function request(entry: RegistryEntry, req: Request, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = connect(entry.socket);
    const dec = new FrameDecoder();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no answer from the ${entry.browser} host within ${timeoutMs} ms`));
    }, timeoutMs);
    sock.on('connect', () => sock.write(encodeFrame(req)));
    sock.on('data', (chunk: Buffer) => {
      const [msg] = dec.push(chunk);
      if (msg) {
        clearTimeout(timer);
        sock.destroy();
        resolve(msg as Response);
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach the ${entry.browser} host: ${e.message}`));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`the ${entry.browser} host closed the connection`));
    });
  });
}

/** Pick the host to talk to: by --browser, else the only live one. */
export function pickBrowser(selector: string | undefined): RegistryEntry {
  const { live } = listEntries();
  if (!live.length) {
    throw new Error('no browser is connected. Run `buu doctor`. Make sure the buu extension is loaded in a running browser.');
  }
  if (selector) {
    const hits = live.filter((e) => e.instanceId === selector || e.browser === selector || e.instanceId.startsWith(selector));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`no connected browser matches "${selector}". Connected: ${live.map((e) => e.browser).join(', ')}`);
    throw new Error(`"${selector}" matches many browsers. Use the instance id: ${hits.map((e) => `${e.browser} ${e.instanceId}`).join(', ')}`);
  }
  if (live.length > 1) {
    throw new Error(
      `many browsers are connected. Use --browser <name|instanceId>:\n${live.map((e) => `  ${e.browser}  ${e.instanceId}`).join('\n')}`,
    );
  }
  return live[0];
}
