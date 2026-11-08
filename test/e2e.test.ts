// End-to-end test on Chrome for Testing (headless, temp profile, temp BUU_HOME).
// It never touches your real browsers. Acceptance tests 3 to 7 and 9 of docs/spec.md.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { WebSocket } from 'ws';

const repo = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(repo, 'cli', 'main.ts');

function findChrome(): string | undefined {
  if (process.env.BUU_CHROME) return process.env.BUU_CHROME;
  const base = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const app = join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(app)) return app;
  }
  return undefined;
}

const chrome = findChrome();
// Unix socket paths are limited to 104 bytes on macOS, and $TMPDIR is long. Use /tmp.
const tmp = mkdtempSync(join('/tmp', 'buu-e2e-'));
const profile = join(tmp, 'profile');
const env: NodeJS.ProcessEnv = { ...process.env, BUU_HOME: join(tmp, 'buu'), BUU_TEST: '1' };
delete env.NODE_TEST_CONTEXT; // node --test marks child node processes. That breaks the CLI and host output.

function buu(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return buuWithInput('', ...args);
}

function buuWithInput(input: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], { env }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
    child.stdin!.end(input);
  });
}

type Result = { stdout: string; stderr: string; code: number };

/** Start the CLI and do not wait. `err()` shows the stderr so far. */
function buuBg(...args: string[]): { done: Promise<Result>; err: () => string; kill: () => void } {
  return buuBgEnv({}, ...args);
}

function buuBgEnv(extra: NodeJS.ProcessEnv, ...args: string[]): { done: Promise<Result>; err: () => string; kill: () => void } {
  let err = '';
  let kill = () => {};
  const done = new Promise<Result>((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], { env: { ...env, ...extra } }, (e, stdout, stderr) => {
      resolve({ stdout, stderr, code: e ? ((e as { code?: number }).code ?? 1) : 0 });
    });
    child.stderr!.on('data', (d) => (err += d));
    child.stdin!.end();
    kill = () => child.kill('SIGKILL');
  });
  return { done, err: () => err, kill: () => kill() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Call a test-only extension method through the hidden `buu __test` command. */
async function ext(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const r = await buu('__test', method, JSON.stringify(params));
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Decode an 8-bit non-interlaced PNG into RGBA pixels (enough for Chrome screenshots). */
function decodePng(buf: Buffer): { width: number; height: number; pixels: (x: number, y: number) => [number, number, number] } {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString();
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert.ok(channels, `color type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = y && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      let v = x;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 255;
    }
  }
  return { width, height, pixels: (x, y) => [out[y * stride + x * channels], out[y * stride + x * channels + 1], out[y * stride + x * channels + 2]] };
}

/** Send one raw CDP command to the relay of a session and return the reply. */
async function rawCdp(session: string, method: string, params: object = {}): Promise<any> {
  const url = (await buu('--session', session, 'cdp-url')).stdout.trim();
  const ws = new WebSocket(url);
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const reply = new Promise<any>((r) => ws.on('message', (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const msg = await reply;
  ws.close();
  return msg;
}

let web: Server;
let base = '';
let chromePid = 0;

function launchChrome() {
  const out = openSync(join(tmp, 'chrome.log'), 'a');
  const child = spawn(
    chrome!,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${join(repo, 'extension')}`,
      '--no-first-run',
      '--no-default-browser-check',
      `${base}/user`,
    ],
    { detached: true, stdio: ['ignore', out, out], env },
  );
  chromePid = child.pid!;
  child.unref();
}

function killChrome() {
  if (!chromePid) return;
  try {
    process.kill(-chromePid, 'SIGTERM'); // our own process group only
  } catch {}
  chromePid = 0;
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const connected = async () => (await buu('status')).stdout.includes('chrome-for-testing');

describe('buu e2e on Chrome for Testing', { skip: chrome ? false : 'Chrome for Testing not found' }, () => {
  before(async () => {
    web = createServer((req, res) => {
      const titles: Record<string, string> = { '/user': 'User Page', '/a': 'Page A', '/b': 'Page B', '/pop': 'Popup Page' };
      res.setHeader('content-type', 'text/html');
      if (req.url === '/top') {
        // A page popover in the top layer. It covers the whole page.
        res.end('<!doctype html><title>Top Page</title><div id=p popover=manual style="position:fixed;inset:0;margin:0;width:100vw;height:100vh;background:#00f">cover</div><script>p.showPopover()</script>');
        return;
      }
      if (req.url === '/red') {
        res.end('<!doctype html><title>Red Page</title><body style="margin:0;background:#fff"><div style="width:300px;height:200px;background:#f00"></div>');
        return;
      }
      res.end(`<!doctype html><title>${titles[req.url ?? ''] ?? 'Other'}</title><h1>${req.url}</h1>`);
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;

    const inst = await buu('install', '--user-data-dir', profile);
    assert.equal(inst.code, 0, inst.stderr);
    launchChrome();
    await waitFor(connected, 30000, 'the browser to connect');
  });

  after(() => {
    killChrome();
    web?.close();
    if (process.env.BUU_E2E_KEEP) console.log(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('doctor is green after install', async () => {
    const r = await buu('doctor', '--user-data-dir', profile);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /✓ host manifest .* points to the wrapper/);
    assert.doesNotMatch(r.stdout, /✗/);
  });

  test('status lists the browser and opens no agent tab', async () => {
    const r = await buu('status');
    assert.match(r.stdout, /^chrome-for-testing /);
    assert.match(r.stdout, /no sessions/);
  });

  test('3: js opens a tab in the group "buu · default"', async () => {
    const r = await buu('js', `await page.goto('${base}/a'); return await page.title()`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), '"Page A"');
    const s = await buu('status');
    assert.match(s.stdout, /\[buu · default\]\s+Page A/);
  });

  test('4: the page and state persist across calls', async () => {
    assert.equal((await buu('js', 'return page.url()')).stdout.trim(), `"${base}/a"`);
    await buu('js', 'state.x = 1');
    assert.equal((await buu('js', 'return state.x')).stdout.trim(), '1');
  });

  test('js reads code from stdin', async () => {
    const r = await buuWithInput('return 40 + 2', 'js');
    assert.equal(r.stdout.trim(), '42');
  });

  test('the page can be read as an aria snapshot', async () => {
    const r = await buu('js', "print(await page.locator('body').ariaSnapshot())");
    assert.match(r.stdout, /heading "\/a"/);
  });

  test('cdp-url prints the relay URL of the session', async () => {
    const r = await buu('--session', 'z', 'cdp-url');
    assert.match(r.stdout.trim(), /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/z$/);
  });

  test('js errors exit 1 with the agent line', async () => {
    const r = await buu('js', "const a = 1;\nthrow new Error('boom')");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /boom/);
    assert.match(r.stderr, /buu-agent\.js:2:/);
  });

  test('print and the return value reach the CLI', async () => {
    const r = await buu('js', "print('hello', {a: 1}); return [1]");
    assert.match(r.stdout, /hello \{ a: 1 \}/);
    assert.match(r.stdout, /\[\s*1\s*\]/);
  });

  test('9: shot saves a PNG', async () => {
    const r = await buu('js', 'await shot()');
    const path = r.stdout.trim();
    assert.match(path, /default-\d+\.png$/);
    assert.equal(readFileSync(path).subarray(1, 4).toString(), 'PNG');
  });

  test('5: two sessions run in parallel, each in its own group', async () => {
    const [a, b] = await Promise.all([
      buu('--session', 'a', 'js', `await page.goto('${base}/a'); return await page.title()`),
      buu('--session', 'b', 'js', `await page.goto('${base}/b'); return await page.title()`),
    ]);
    assert.equal(a.stdout.trim(), '"Page A"');
    assert.equal(b.stdout.trim(), '"Page B"');
    const s = (await buu('status')).stdout;
    assert.match(s, /\[buu · a\]\s+Page A/);
    assert.match(s, /\[buu · b\]\s+Page B/);
  });

  test('a popup joins the session', async () => {
    const r = await buu(
      '--session',
      'a',
      'js',
      `const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('${base}/pop') })]);
       await p.waitForLoadState(); return await p.title()`,
    );
    assert.equal(r.stdout.trim(), '"Popup Page"');
    assert.match((await buu('status')).stdout, /\[buu · a\]\s+Popup Page/);
  });

  test('a timeout drops the kernel and keeps the tabs', async () => {
    const r = await buu('--session', 'b', '--timeout', '1500', 'js', 'while (true) {}');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /timeout after 1500 ms/);
    const again = await buu('--session', 'b', 'js', 'return await page.title()');
    assert.equal(again.stdout.trim(), '"Page B"');
  });

  test('6: tabs lists user tabs, claim makes the tab the page, the tab stays out of the group', async () => {
    const t = await buu('tabs');
    const line = t.stdout.split('\n').find((l) => l.includes('User Page'));
    assert.ok(line, `no user tab in:\n${t.stdout}`);
    assert.doesNotMatch(t.stdout, /Page B/); // agent tabs are not user tabs
    const id = line.split('\t')[0];
    const c = await buu('--session', 'c', 'claim', id);
    assert.equal(c.code, 0, c.stderr);
    assert.equal((await buu('--session', 'c', 'js', 'return await page.title()')).stdout.trim(), '"User Page"');
    const s = (await buu('status')).stdout;
    assert.match(s, new RegExp(`tab ${id}  \\[claimed\\]  User Page`));
  });

  test('7: end closes session tabs and leaves the claimed tab open', async () => {
    const e = await buu('--session', 'c', 'end');
    assert.match(e.stdout, /detached 1 claimed/);
    assert.match((await buu('tabs')).stdout, /User Page/);
    const a = await buu('--session', 'a', 'end');
    assert.match(a.stdout, /closed 2 tab/); // the first tab and the popup
    const s = (await buu('status')).stdout;
    assert.doesNotMatch(s, /session a /);
    assert.match((await buu('tabs')).stdout, /User Page/);
  });

  test('end --keep leaves the named agent tab open', async () => {
    await buu('--session', 'k', 'js', `await page.goto('${base}/b')`);
    const tabs = (await buu('status')).stdout;
    const id = /tab (\d+)  \[buu · k\]/.exec(tabs)![1];
    const e = await buu('--session', 'k', 'end', '--keep', id);
    assert.match(e.stdout, /kept 1/);
    assert.match((await buu('tabs')).stdout, new RegExp(`^${id}\\t`, 'm'));
  });

  test('a kept tab leaves the session group', async () => {
    // Claim the kept tab. status shows the group title when the tab is still in a group.
    const id = /^(\d+)\t.*Page B/m.exec((await buu('tabs')).stdout)![1];
    const c = await buu('--session', 'k2', 'claim', id);
    assert.equal(c.code, 0, c.stderr);
    const s = (await buu('status')).stdout;
    assert.match(s, new RegExp(`tab ${id}  \\[claimed\\]  Page B`));
    await buu('--session', 'k2', 'end');
  });

  test('a popup of one session joins it while another session opens tabs', async () => {
    // Session p warms up first. Then both sessions run at the same time.
    await buu('--session', 'p', 'js', `await page.goto('${base}/b')`);
    await buu('--session', 'n', 'js', `await page.goto('${base}/a')`);
    const [, r] = await Promise.all([
      buu('--session', 'n', 'js', `for (let i = 0; i < 25; i++) { const p = await context.newPage(); await p.close() }`),
      buu(
        '--session',
        'p',
        'js',
        `let n = 0;
         for (let i = 0; i < 25; i++) {
           const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('${base}/pop') })]);
           await p.waitForLoadState(); n++;
         }
         return n`,
      ),
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), '25');
    assert.equal(((await buu('status')).stdout.match(/\[buu · p\]/g) ?? []).length, 26); // the page and 25 popups
    await buu('--session', 'n', 'end');
    await buu('--session', 'p', 'end');
  });

  test('v1.1: a new agent tab opens in the background, in a collapsed group', async () => {
    const before = await ext('test.tabs');
    const user = before.tabs.find((t: any) => t.active);
    const r = await buu('--session', 'bg', 'js', `await page.goto('${base}/red'); return await page.title()`);
    assert.equal(r.stdout.trim(), '"Red Page"');
    const id = Number(/tab (\d+)  \[buu · bg\]/.exec((await buu('status')).stdout)![1]);
    const after = await ext('test.tabs');
    assert.equal(after.tabs.find((t: any) => t.id === id).active, false);
    assert.equal(after.tabs.find((t: any) => t.id === user.id).active, true);
    const group = after.groups.find((g: any) => g.title === 'buu · bg');
    assert.equal(group?.collapsed, true);
  });

  test('v1.1: shot of a background tab is a real image', async () => {
    const r = await buu('--session', 'bg', 'js', 'await shot()');
    assert.equal(r.code, 0, r.stderr);
    const png = decodePng(readFileSync(r.stdout.trim()));
    assert.equal(png.pixels(100, 100).join(), '255,0,0'); // the red block
    assert.equal(png.pixels(png.width - 5, png.height - 5).join(), '255,255,255'); // the white page
  });

  test('v1.1: requestAnimationFrame runs in a background tab', async () => {
    const r = await buu('--session', 'bg', 'js', `return await page.evaluate(() => new Promise((res) => requestAnimationFrame((t) => res(typeof t))))`);
    assert.equal(r.stdout.trim(), '"number"');
  });

  test('v1.1: agents cannot raise a tab', async () => {
    const r = await buu('--session', 'bg', 'js', 'await page.bringToFront()');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /buu: agents cannot raise tabs; use handoff\(\)/);
    const raw = await rawCdp('raw', 'Page.bringToFront');
    assert.match(raw.error?.message, /agents cannot raise tabs/);
    const act = await rawCdp('raw', 'Target.activateTarget', { targetId: 'x' });
    assert.deepEqual(act.result, {}); // a no-op success
    const tabs = await ext('test.tabs');
    assert.equal(tabs.tabs.filter((t: any) => t.active).length, 1); // still the user tab
    await buu('--session', 'bg', 'end');
  });

  test('v1.1: lend by toolbar click, claim --lent, take back stops the running call', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    const none = await buu('--session', 'L', 'claim', '--lent');
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no tab is lent/);

    await ext('test.toolbarClick', { tabId: id }); // the user lends the tab
    assert.equal((await ext('test.badge', { tabId: id })).text, 'ON');
    const first = (await buu('tabs')).stdout.split('\n')[0];
    assert.match(first, new RegExp(`^${id}\\tUser Page\\t.*\\t\\[lent\\]$`));

    const c = await buu('--session', 'L', 'claim', '--lent');
    assert.equal(c.code, 0, c.stderr);
    assert.equal((await buu('--session', 'L', 'js', 'return await page.title()')).stdout.trim(), '"User Page"');
    // RUN shows while a call runs. The user takes the tab back during the call.
    const run = buuBg('--session', 'L', 'js', 'await new Promise((r) => setTimeout(r, 20000))');
    await waitFor(async () => (await ext('test.badge', { tabId: id })).text === 'RUN', 5000, 'the RUN badge');
    await ext('test.toolbarClick', { tabId: id });
    const r = await run.done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the user took tab \d+ back/);
    assert.equal((await ext('test.badge', { tabId: id })).text, 'on'); // the global badge again
    assert.doesNotMatch((await buu('status')).stdout, new RegExp(`tab ${id} `));
    assert.match((await buu('tabs')).stdout, /User Page/); // the tab stays open
    assert.doesNotMatch((await buu('tabs')).stdout, /\[lent\]/);

    const next = await buu('--session', 'L', 'js', 'return 1'); // the running call reported it already
    assert.equal(next.code, 0, next.stderr);
    await buu('--session', 'L', 'end');
  });

  test('v1.1: a take-back between calls is reported once', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    await ext('test.toolbarClick', { tabId: id });
    assert.equal((await buu('--session', 'T', 'claim', '--lent')).code, 0);
    await ext('test.toolbarClick', { tabId: id }); // no call runs
    const next = await buu('--session', 'T', 'js', 'return 1');
    assert.equal(next.code, 1);
    assert.match(next.stderr, /the user took tab \d+ back/);
    const after = await buu('--session', 'T', 'js', 'return 1');
    assert.equal(after.code, 0, after.stderr);
    await buu('--session', 'T', 'end');
  });

  test('v1.1: a host crash clears the RUN badge of a claimed tab', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    await ext('test.toolbarClick', { tabId: id });
    assert.equal((await buu('--session', 'R', 'claim', '--lent')).code, 0);
    const run = buuBg('--session', 'R', 'js', 'await new Promise((r) => setTimeout(r, 20000))');
    await waitFor(async () => (await ext('test.badge', { tabId: id })).text === 'RUN', 5000, 'the RUN badge');
    const pid = Number(/pid (\d+)/.exec((await buu('status')).stdout)![1]);
    process.kill(pid, 'SIGKILL');
    await run.done;
    await waitFor(async () => {
      const m = /pid (\d+)/.exec((await buu('status')).stdout);
      return !!m && Number(m[1]) !== pid;
    }, 15000, 'the extension to start a new host');
    assert.equal((await ext('test.badge', { tabId: id })).text, 'ON'); // claimed, no call runs
    await ext('test.toolbarClick', { tabId: id }); // take back
    assert.equal((await ext('test.badge', { tabId: id })).text, 'on');
  });

  test('v1.1: agents cannot close a lent or claimed tab', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    await ext('test.toolbarClick', { tabId: id });
    assert.equal((await buu('--session', 'X', 'claim', '--lent')).code, 0);
    // A raw CDP client on the same session. Playwright page.close() hides the refusal and waits.
    const url = (await buu('--session', 'X', 'cdp-url')).stdout.trim();
    const ws = new WebSocket(url);
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    const targetId = await new Promise<string>((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.method === 'Target.attachedToTarget') resolve(m.params.targetInfo.targetId);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
    });
    const reply = new Promise<any>((resolve) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.id === 2) resolve(m);
      }),
    );
    ws.send(JSON.stringify({ id: 2, method: 'Target.closeTarget', params: { targetId } }));
    assert.deepEqual((await reply).result, { success: true }); // the agent loses the tab
    ws.close();
    assert.match((await buu('tabs')).stdout, /User Page/); // the tab stays open
    assert.doesNotMatch((await buu('status')).stdout, new RegExp(`tab ${id} `));
    await buu('--session', 'X', 'end');
    assert.match((await buu('tabs')).stdout, /User Page/);
    await ext('test.toolbarClick', { tabId: id }); // take back
  });

  test('v1.1: page.close() on a claimed tab returns and leaves the tab open', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    await ext('test.toolbarClick', { tabId: id });
    assert.equal((await buu('--session', 'P', 'claim', '--lent')).code, 0);
    const t0 = Date.now();
    const r = await buu('--session', 'P', 'js', 'await page.close(); return "closed"');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 15000, 'page.close() must not wait for a timeout');
    assert.match((await buu('tabs')).stdout, /User Page/);
    await buu('--session', 'P', 'end');
    await ext('test.toolbarClick', { tabId: id }); // take back
  });

  test('v1.1: a second toolbar click on a lent tab takes it back', async () => {
    const id = Number(/^(\d+)\t.*User Page/m.exec((await buu('tabs')).stdout)![1]);
    await ext('test.toolbarClick', { tabId: id });
    assert.match((await buu('tabs')).stdout, /\[lent\]/);
    await ext('test.toolbarClick', { tabId: id });
    assert.doesNotMatch((await buu('tabs')).stdout, /\[lent\]/);
    assert.equal((await ext('test.badge', { tabId: id })).text, 'on');
  });

  test('v1.1: claim --lent fails with the list when many tabs are lent', async () => {
    const ids = [...(await buu('tabs')).stdout.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
    assert.ok(ids.length >= 2, 'need two user tabs');
    for (const id of ids.slice(0, 2)) await ext('test.toolbarClick', { tabId: id });
    const r = await buu('--session', 'M', 'claim', '--lent');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /2 tabs are lent/);
    assert.equal((r.stderr.match(/\[lent\]/g) ?? []).length, 2);
    for (const id of ids.slice(0, 2)) await ext('test.toolbarClick', { tabId: id });
  });

  describe('v1.1: handoff', () => {
    const agentTab = async () => Number(/tab (\d+)  \[buu · H\]/.exec((await buu('status')).stdout)![1]);
    const cardShown = (id: number) => async () => (await ext('test.card', { tabId: id })) !== null;

    test('waits past the CLI timeout, shows the card and WAIT, returns after a toolbar click', async () => {
      assert.equal((await buu('--session', 'H', 'js', `await page.goto('${base}/a')`)).code, 0);
      const id = await agentTab();
      // A short wait grace makes the CLI socket timeout (1000 + 300 ms) visible in this test.
      const run = buuBgEnv({ BUU_WAIT_GRACE_MS: '300' }, '--session', 'H', '--timeout', '1000', 'js', `return await handoff('Sign in, then continue', { timeoutMs: 60000 })`);
      await waitFor(cardShown(id), 8000, 'the handoff card');
      const card = await ext('test.card', { tabId: id });
      assert.equal(card.message, 'Sign in, then continue');
      assert.equal(card.origin, base);
      assert.equal((await ext('test.badge', { tabId: id })).text, 'WAIT');
      assert.equal((await ext('test.tabs')).tabs.find((t: any) => t.id === id).active, true); // the user can see it
      assert.equal(run.err(), `buu: waiting for the user in tab ${id}: Sign in, then continue\n`);

      await sleep(3000); // longer than the host timeout (1000 ms) and the CLI timeout (1300 ms)
      const early = await Promise.race([run.done, sleep(50).then(() => 'waiting')]);
      assert.equal(early, 'waiting', 'the call timeout must pause during a handoff');

      await ext('test.toolbarClick', { tabId: id }); // the user clicks the toolbar button
      const r = await run.done;
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { url: `${base}/a`, title: 'Page A' });
      assert.equal(await ext('test.card', { tabId: id }), null);
      assert.notEqual((await ext('test.badge', { tabId: id })).text, 'WAIT');
    });

    test('the card shows again after a navigation, and a real click on it continues', async () => {
      const id = await agentTab();
      const run = buuBg('--session', 'H', 'js', `await handoff('Pick a plan', { timeoutMs: 60000 }); return page.url()`);
      await waitFor(cardShown(id), 8000, 'the handoff card');
      await ext('test.navigate', { tabId: id, url: `${base}/b` });
      await waitFor(async () => (await ext('test.card', { tabId: id }))?.href === `${base}/b`, 8000, 'the card after navigation');
      assert.equal((await ext('test.badge', { tabId: id })).text, 'WAIT');
      await ext('test.cardClick', { tabId: id });
      const r = await run.done;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), `"${base}/b"`);
      assert.equal(await ext('test.card', { tabId: id }), null);
    });

    test('the card stays on top of a page popover, so a click on it continues', async () => {
      assert.equal((await buu('--session', 'H', 'js', `await page.goto('${base}/top')`)).code, 0);
      const id = await agentTab();
      const run = buuBg('--session', 'H', 'js', `await handoff('Under a popover', { timeoutMs: 60000 }); return 'continued'`);
      await waitFor(cardShown(id), 8000, 'the handoff card');
      await ext('test.cardClick', { tabId: id }); // a click on a covered card would hit the page
      const r = await run.done;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), '"continued"');
    });

    test('start runs after the card shows, and a failing start ends the handoff', async () => {
      const id = await agentTab();
      const ok = buuBg('--session', 'H', 'js', `await handoff('Allow it', { timeoutMs: 60000, start: async () => { state.started = true } }); return state.started`);
      await waitFor(cardShown(id), 8000, 'the handoff card');
      await ext('test.toolbarClick', { tabId: id });
      assert.equal((await ok.done).stdout.trim(), 'true');

      const bad = await buu('--session', 'H', 'js', `await handoff('x', { timeoutMs: 60000, start: async () => { throw new Error('start failed') } })`);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /start failed/);
      assert.equal(await ext('test.card', { tabId: id }), null);
    });

    test('the card goes away when the CLI command ends', async () => {
      const id = await agentTab();
      const run = buuBg('--session', 'H', 'js', `await handoff('Anyone?', { timeoutMs: 60000 })`);
      await waitFor(cardShown(id), 8000, 'the handoff card');
      run.kill(); // the agent harness cancels the command
      await waitFor(async () => (await ext('test.card', { tabId: id })) === null, 8000, 'the card to go away');
      assert.notEqual((await ext('test.badge', { tabId: id })).text, 'WAIT');
    });

    test('a handoff that nobody answers times out, removes the card, and keeps the kernel', async () => {
      const id = await agentTab();
      const r = await buu('--session', 'H', 'js', `state.k = 1; await handoff('Hello?', { timeoutMs: 1500 })`);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /handoff timed out/);
      assert.equal(await ext('test.card', { tabId: id }), null);
      assert.notEqual((await ext('test.badge', { tabId: id })).text, 'WAIT');
      assert.equal((await buu('--session', 'H', 'js', 'return state.k')).stdout.trim(), '1'); // same kernel
      await buu('--session', 'H', 'end');
    });
  });

  test('8 (host crash): the extension starts the host again within 15 s', async () => {
    const pid = Number(/pid (\d+)/.exec((await buu('status')).stdout)![1]);
    process.kill(pid, 'SIGKILL'); // the host is our own child of the test browser
    await waitFor(async () => {
      const m = /pid (\d+)/.exec((await buu('status')).stdout);
      return !!m && Number(m[1]) !== pid;
    }, 15000, 'the extension to start a new host');
  });

  test('8 (headless): the browser connects again after a restart', async () => {
    killChrome();
    await waitFor(async () => !(await connected()), 15000, 'the old host to exit');
    launchChrome();
    await waitFor(connected, 30000, 'the browser to connect again');
    const r = await buu('js', `await page.goto('${base}/a'); return await page.title()`);
    assert.equal(r.stdout.trim(), '"Page A"');
    await buu('end');
  });
});
