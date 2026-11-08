import { Worker } from 'node:worker_threads';
import type { Logger } from './log.ts';

export type KernelResult = { ok: true; output: string } | { ok: false; error: string; output?: string };

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };
/** The kernel asks the host to do something (for example a handoff). The answer is `{ ok, error?, data? }`. */
export type KernelRequest = (op: string, payload: Record<string, unknown>) => Promise<unknown>;
type Deadline = { timer: NodeJS.Timeout; at: number; fire: () => void; remaining?: number };

/** Main-thread side of one session kernel (a worker thread running playwright-core). */
export class Kernel {
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, Pending>();
  #deadline?: Deadline;
  dead = false;
  readonly session: string;

  constructor(session: string, cdpUrl: string, log: Logger, onExit: () => void, onRequest: KernelRequest) {
    this.session = session;
    this.#worker = new Worker(new URL('./kernel.ts', import.meta.url), {
      workerData: { session, cdpUrl },
      stdout: true, // keep worker output off our stdout (native messaging)
      stderr: true,
    });
    this.#worker.stdout.on('data', (d) => log(`kernel ${session} stdout:`, String(d).trimEnd()));
    this.#worker.stderr.on('data', (d) => log(`kernel ${session} stderr:`, String(d).trimEnd()));
    this.#worker.on('message', (m: { id: number; kreq?: number; op?: string }) => {
      if (m.kreq !== undefined) {
        const { kreq, op, ...payload } = m as { kreq: number; op: string };
        onRequest(op, payload).then(
          (data) => this.#worker.postMessage({ kres: kreq, ok: true, data }),
          (e) => this.#worker.postMessage({ kres: kreq, ok: false, error: String(e?.message ?? e) }),
        );
        return;
      }
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
      const fire = () => {
        this.#pending.delete(id);
        this.kill();
        reject(
          new Error(
            `timeout after ${timeoutMs} ms. The kernel was dropped (state is reset). Session tabs stay open. The next call starts a new kernel.`,
          ),
        );
      };
      const done = () => {
        clearTimeout(this.#deadline?.timer);
        this.#deadline = undefined;
      };
      this.#deadline = { timer: setTimeout(fire, timeoutMs), at: Date.now() + timeoutMs, fire };
      this.#pending.set(id, {
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.#worker.postMessage({ id, op, ...payload });
    });
  }

  /** Stop the call timeout clock (a handoff waits for the user). The time left stays. */
  pauseDeadline() {
    const d = this.#deadline;
    if (!d || d.remaining !== undefined) return;
    clearTimeout(d.timer);
    d.remaining = Math.max(d.at - Date.now(), 0);
  }

  resumeDeadline() {
    const d = this.#deadline;
    if (!d || d.remaining === undefined) return;
    d.at = Date.now() + d.remaining;
    d.timer = setTimeout(d.fire, d.remaining);
    d.remaining = undefined;
  }

  kill() {
    this.dead = true;
    void this.#worker.terminate();
  }
}
