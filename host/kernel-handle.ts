import { Worker } from 'node:worker_threads';
import type { Logger } from './log.ts';

export type KernelResult = { ok: true; output: string } | { ok: false; error: string; output?: string };

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

/** Main-thread side of one session kernel (a worker thread running playwright-core). */
export class Kernel {
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, Pending>();
  dead = false;
  readonly session: string;

  constructor(session: string, cdpUrl: string, log: Logger, onExit: () => void) {
    this.session = session;
    this.#worker = new Worker(new URL('./kernel.ts', import.meta.url), {
      workerData: { session, cdpUrl },
      stdout: true, // keep worker output off our stdout (native messaging)
      stderr: true,
    });
    this.#worker.stdout.on('data', (d) => log(`kernel ${session} stdout:`, String(d).trimEnd()));
    this.#worker.stderr.on('data', (d) => log(`kernel ${session} stderr:`, String(d).trimEnd()));
    this.#worker.on('message', (m: { id: number }) => {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      p.resolve(m);
    });
    this.#worker.on('error', (e: Error) => {
      log(`kernel ${session} error`, e);
      this.#fail(new Error(`kernel crashed: ${e.message}`));
    });
    this.#worker.on('exit', () => {
      this.#fail(new Error('kernel exited'));
      onExit();
    });
  }

  #fail(e: Error) {
    this.dead = true;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  call(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.dead) return Promise.reject(new Error('kernel is gone'));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.kill();
        reject(
          new Error(
            `timeout after ${timeoutMs} ms. The kernel was dropped (state is reset). Session tabs stay open. The next call starts a new kernel.`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#worker.postMessage({ id, op, ...payload });
    });
  }

  kill() {
    this.dead = true;
    void this.#worker.terminate();
  }
}
