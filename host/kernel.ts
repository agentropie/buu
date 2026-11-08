// One kernel = one worker thread = one session. Holds a playwright-core connection to the relay.
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { shotsDir } from './paths.ts';

const { session, cdpUrl } = workerData as { session: string; cdpUrl: string };
const OUTPUT_CAP = 200 * 1024;
const AGENT_FILE = 'buu-agent.js';
const FRAME_LINE_OFFSET = 2; // lines the Function constructor adds before the agent code

let browser: Browser;
let context: BrowserContext;
let current: Page | undefined;
const state: Record<string, unknown> = {};
let out: string[] = [];

process.on('unhandledRejection', () => {}); // agent code must not crash the kernel

function fmt(v: unknown): string {
  return typeof v === 'string' ? v : inspect(v, { depth: 4, breakLength: 120 });
}
function print(...values: unknown[]) {
  out.push(values.map(fmt).join(' '));
}

async function ensurePage(): Promise<Page> {
  if (current && !current.isClosed()) return current;
  const live = context.pages().filter((p) => !p.isClosed());
  current = live.at(-1) ?? (await context.newPage());
  return current;
}

async function newPage(): Promise<Page> {
  current = await context.newPage();
  return current;
}

function usePage(p: Page) {
  if (!context.pages().includes(p)) throw new Error('usePage: page is not in this session');
  current = p;
}

async function shot(opts: Record<string, unknown> = {}) {
  const page = await ensurePage();
  mkdirSync(shotsDir, { recursive: true });
  const re = new RegExp(`^${session.replace(/[.]/g, '\\.')}-(\\d+)\\.png$`);
  let n = 0;
  for (const f of readdirSync(shotsDir)) {
    const m = re.exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const path = join(shotsDir, `${session}-${n + 1}.png`);
  await page.screenshot({ ...opts, path });
  print(path);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (g: object) => Promise<unknown>;

function render(result: unknown): string {
  if (result === undefined) return '';
  try {
    const s = JSON.stringify(result, null, 2);
    if (s !== undefined) return s;
  } catch {}
  return inspect(result, { depth: 3, breakLength: 120 });
}

function finish(): string {
  let text = out.join('\n');
  const size = Buffer.byteLength(text);
  if (size > OUTPUT_CAP) {
    text = Buffer.from(text).subarray(0, OUTPUT_CAP).toString('utf8') + `\n[buu: output cut at ${OUTPUT_CAP} of ${size} bytes]`;
  }
  return text;
}

function agentFrame(e: unknown): string | undefined {
  const stack = e instanceof Error ? e.stack : undefined;
  const line = stack?.split('\n').find((l) => l.includes(AGENT_FILE));
  const m = line && new RegExp(`${AGENT_FILE.replace('.', '\\.')}:(\\d+):(\\d+)`).exec(line);
  return m ? `at ${AGENT_FILE}:${Number(m[1]) - FRAME_LINE_OFFSET}:${m[2]}` : undefined;
}

async function runJs(code: string) {
  out = [];
  await ensurePage();
  const quiet = { log: print, info: print, warn: print, error: print, debug: print };
  const g = {
    get page() {
      return current;
    },
    context,
    browser,
    state,
    print,
    shot,
    newPage,
    usePage,
    console: quiet,
  };
  try {
    const fn = new AsyncFunction('__g', `with (__g) { ${code}\n}\n//# sourceURL=${AGENT_FILE}`);
    const result = await fn(g);
    const r = render(result);
    if (r) out.push(r);
    return { ok: true, output: finish() };
  } catch (e) {
    const name = e instanceof Error && e.name !== 'Error' ? `${e.name}: ` : '';
    const msg = e instanceof Error ? e.message : String(e);
    const frame = agentFrame(e);
    return { ok: false, error: `${name}${msg}${frame ? `\n    ${frame}` : ''}`, output: finish() };
  }
}

async function claim(url: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const pages = context.pages().filter((p) => !p.isClosed());
    const hit = pages.filter((p) => p.url() === url).at(-1);
    if (hit || (Date.now() > deadline && pages.length)) {
      current = hit ?? pages.at(-1);
      return;
    }
    if (Date.now() > deadline) throw new Error('claimed tab did not show up in the kernel');
    await new Promise((r) => setTimeout(r, 100));
  }
}

parentPort!.on('message', async (m: { id: number; op: string; code?: string; url?: string; timeoutMs?: number }) => {
  try {
    let res: object;
    if (m.op === 'init') {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: m.timeoutMs });
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('relay gave no browser context');
      context = ctx;
      res = { ok: true };
    } else if (m.op === 'js') {
      res = await runJs(m.code!);
    } else if (m.op === 'claim') {
      await claim(m.url!);
      res = { ok: true };
    } else {
      res = { ok: false, error: `unknown op ${m.op}` };
    }
    parentPort!.postMessage({ id: m.id, ...res });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
