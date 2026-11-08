import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, encodeFrame } from './frame.ts';

const MAX_TO_CHROME = 1024 * 1024 - 1024; // Chrome rejects host messages above 1 MB

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

/** JSON-RPC over Chrome native messaging (stdin/stdout). Emits 'event' and 'close'. */
export class ExtensionChannel extends EventEmitter {
  #out: Writable;
  #next = 1;
  #pending = new Map<number, Pending>();
  closed = false;

  constructor(input: Readable, output: Writable) {
    super();
    this.#out = output;
    const dec = new FrameDecoder();
    input.on('data', (chunk: Buffer) => {
      try {
        for (const msg of dec.push(chunk)) this.#onMessage(msg as any);
      } catch (e) {
        this.emit('error-log', e);
      }
    });
    input.on('end', () => this.#close());
    input.on('close', () => this.#close());
    output.on('error', () => this.#close());
  }

  #close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.#pending.values()) p.reject(new Error('browser disconnected'));
    this.#pending.clear();
    this.emit('close');
  }

  #onMessage(msg: { id?: number; result?: unknown; error?: string; event?: string }) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.event) this.emit('event', msg);
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('browser disconnected'));
    const id = this.#next++;
    const frame = encodeFrame({ id, method, params });
    if (frame.length > MAX_TO_CHROME) {
      return Promise.reject(new Error(`${method}: message too large for Chrome native messaging (${frame.length} bytes)`));
    }
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#out.write(frame);
    });
  }
}
