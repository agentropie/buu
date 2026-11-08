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
const env: NodeJS.ProcessEnv = { ...process.env, BUU_HOME: join(tmp, 'buu') };
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
