#!/usr/bin/env node
import { listEntries } from '../host/registry.ts';
import { pickBrowser, request } from './client.ts';
import { doctor } from './doctor.ts';
import { installReport } from './install.ts';

const USAGE = `buu: drive your real browser from the shell.

Usage:
  buu js [code]            run JS in the session kernel (code from argument or stdin)
  buu tabs                 list the open tabs of the browser
  buu claim <tabId>        attach a user tab to the session
  buu end [--keep <id>...] end the session and close its tabs
  buu status               show browsers, sessions, and tabs
  buu cdp-url              print the CDP relay URL of the session
  buu install [--user-data-dir <dir>]
  buu doctor [--user-data-dir <dir>]

Flags: --session <name> (default $BUU_SESSION or "default"), --browser <name|instanceId>, --timeout <ms> (default 30000)`;

type Args = { positional: string[]; flags: Map<string, string[]> };

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const valueFlags = new Set(['session', 'browser', 'timeout', 'user-data-dir']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') {
      const vals = flags.get('keep') ?? [];
      while (i + 1 < argv.length && /^\d+$/.test(argv[i + 1])) vals.push(argv[++i]);
      flags.set('keep', vals);
    } else if (a.startsWith('--') && valueFlags.has(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      flags.set(a.slice(2), [v]);
    } else if (a.startsWith('--') && a.includes('=') && valueFlags.has(a.slice(2, a.indexOf('=')))) {
      flags.set(a.slice(2, a.indexOf('=')), [a.slice(a.indexOf('=') + 1)]);
    } else if (a === '--help' || a === '-h') {
      positional.push('help');
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(msg: string): never {
  process.stderr.write(`buu: ${msg}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const flag = (n: string) => flags.get(n)?.[0];
  const session = flag('session') ?? process.env.BUU_SESSION ?? 'default';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) fail(`bad session name "${session}". Use letters, digits, ".", "_", "-" (max 64).`);
  const timeoutMs = flag('timeout') ? Number(flag('timeout')) : 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('--timeout needs a number of milliseconds');
  const wait = timeoutMs + 15000;

  switch (cmd) {
    case undefined:
    case 'help':
      console.log(USAGE);
      return;

    case 'install':
      console.log(installReport(flag('user-data-dir')));
      return;

    case 'doctor': {
      const { text, failed } = await doctor(flag('user-data-dir'));
      console.log(text);
      process.exit(failed ? 1 : 0);
    }

    case 'cdp-url': {
      const e = pickBrowser(flag('browser'));
      console.log(`${e.cdpBase}/${session}`);
      return;
    }

    case 'status': {
      const { live } = listEntries();
      const entries = flag('browser') ? [pickBrowser(flag('browser'))] : live;
      if (!entries.length) {
        console.log('no browser is connected.');
        return;
      }
      for (const e of entries) {
        const r = await request(e, { cmd: 'status' }, 10000);
        if (!r.ok) {
          console.log(`${e.browser}  ${e.instanceId}  error: ${r.error}`);
          continue;
        }
        const d = r.data as any;
        console.log(`${d.browser}  ${d.instanceId}  pid ${d.pid}  ext ${d.extensionVersion}`);
        if (!d.sessions.length) console.log('  no sessions');
        for (const s of d.sessions) {
          console.log(`  session ${s.name}  kernel ${s.kernel ? 'running' : 'idle'}  ${s.tabs.length} tab(s)`);
          for (const t of s.tabs) {
            const where = t.groupTitle ? `[${t.groupTitle}]` : t.claimed ? '[claimed]' : '[no group]';
            console.log(`    tab ${t.id}  ${where}  ${oneLine(t.title)}  ${t.url}`);
          }
        }
      }
      return;
    }

    case 'tabs': {
      const r = await request(pickBrowser(flag('browser')), { cmd: 'tabs' }, 15000);
      if (!r.ok) fail(r.error);
      const tabs = (r.data as any[])
        .filter((t) => !t.session || t.claimed)
        .sort((a, b) => b.lastAccessed - a.lastAccessed);
      for (const t of tabs) console.log(`${t.id}\t${oneLine(t.title)}\t${t.url}${t.claimed ? `\t(claimed by ${t.session})` : ''}`);
      return;
    }

    case 'claim': {
      const tabId = Number(rest[0]);
      if (!Number.isInteger(tabId)) fail('usage: buu claim <tabId> (get the id from `buu tabs`)');
      const r = await request(pickBrowser(flag('browser')), { cmd: 'claim', session, tabId, timeoutMs }, wait);
      if (!r.ok) fail(r.error);
      const d = r.data as any;
      console.log(`claimed tab ${d.tabId} in session "${session}": ${oneLine(d.title)}  ${d.url}`);
      return;
    }

    case 'end': {
      const keep = (flags.get('keep') ?? []).map(Number);
      const r = await request(pickBrowser(flag('browser')), { cmd: 'end', session, keep }, wait);
      if (!r.ok) fail(r.error);
      const d = r.data as { closed: number[]; detached: number[]; kept: number[] };
      console.log(
        `ended session "${session}": closed ${d.closed.length} tab(s), detached ${d.detached.length} claimed tab(s), kept ${d.kept.length}`,
      );
      return;
    }

    case 'js': {
      let code = rest[0];
      if (code === undefined || code === '-') {
        if (process.stdin.isTTY) fail('usage: buu js "<code>" (or pipe code on stdin)');
        code = await readStdin();
      }
      const r = await request(pickBrowser(flag('browser')), { cmd: 'js', session, code, timeoutMs }, wait);
      if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : `${r.output}\n`);
      if (!r.ok) {
        process.stderr.write(`${r.error}\n`);
        process.exit(1);
      }
      return;
    }

    case '__test': {
      // Hidden. The host answers only when BUU_TEST=1. The e2e test uses it for fake toolbar clicks.
      const r = await request(pickBrowser(flag('browser')), { cmd: 'test', method: rest[0], params: rest[1] ? JSON.parse(rest[1]) : {} }, 15000);
      if (!r.ok) fail(r.error);
      console.log(JSON.stringify(r.data));
      return;
    }

    default:
      fail(`unknown command "${cmd}". Run \`buu help\`.`);
  }
}

function oneLine(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim();
}

main().catch((e: Error) => fail(e.message));
