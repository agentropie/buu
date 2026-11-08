import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { FrameDecoder, encodeFrame } from './frame.ts';
import type { Hub } from './hub.ts';
import { runDir } from './paths.ts';

export type Request = {
  cmd: 'js' | 'tabs' | 'claim' | 'end' | 'status' | 'ping' | 'test';
  session?: string;
  code?: string;
  tabId?: number;
  keep?: number[];
  method?: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
};
export type Response = { ok: true; data?: unknown; output?: string } | { ok: false; error: string; output?: string };

/** The CLI socket. One request and one response for each connection. */
export function startServer(hub: Hub, path: string, info: () => unknown): Promise<Server> {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path);
  } catch {}
  const server = createServer((sock) => {
    const dec = new FrameDecoder();
    let handled = false;
    sock.on('data', (chunk: Buffer) => {
      if (handled) return;
      let msgs: unknown[];
      try {
        msgs = dec.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      if (!msgs.length) return;
      handled = true;
      handle(hub, msgs[0] as Request, info).then(
        (res) => sock.end(encodeFrame(res)),
        (e) => sock.end(encodeFrame({ ok: false, error: String(e?.message ?? e) })),
      );
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

async function handle(hub: Hub, req: Request, info: () => unknown): Promise<Response> {
  const session = req.session ?? 'default';
  const timeoutMs = req.timeoutMs ?? 30000;
  switch (req.cmd) {
    case 'ping':
      return { ok: true, data: info() };
    case 'status':
      return { ok: true, data: { ...(info() as object), sessions: await hub.status() } };
    case 'tabs':
      return { ok: true, data: await hub.listUserTabs() };
    case 'js': {
      const r = await hub.runJs(session, req.code ?? '', timeoutMs);
      return r.ok ? { ok: true, output: r.output ?? '' } : { ok: false, error: r.error ?? 'error', output: r.output };
    }
    case 'claim':
      return { ok: true, data: await hub.claim(session, Number(req.tabId), timeoutMs) };
    case 'end':
      return { ok: true, data: await hub.end(session, req.keep ?? []) };
    case 'test':
      // Test-only RPC to the extension (fake toolbar clicks and so on). Off unless BUU_TEST=1.
      if (process.env.BUU_TEST !== '1' || !req.method?.startsWith('test.')) return { ok: false, error: 'unknown command test' };
      return { ok: true, data: await hub.ext.call(req.method, req.params ?? {}) };
    default:
      return { ok: false, error: `unknown command ${(req as { cmd: string }).cmd}` };
  }
}
