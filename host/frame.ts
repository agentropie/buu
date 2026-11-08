// Frame format shared by Chrome native messaging and the CLI socket:
// 4-byte unsigned length (native byte order, little endian on macOS) + UTF-8 JSON.

const MAX_FRAME = 512 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32LE(0);
      if (len > MAX_FRAME) throw new Error(`frame too large: ${len}`);
      if (this.#buf.length < 4 + len) break;
      out.push(JSON.parse(this.#buf.subarray(4, 4 + len).toString('utf8')));
      this.#buf = this.#buf.subarray(4 + len);
    }
    return out;
  }
}
