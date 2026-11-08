# buu v1 spec

Status: GO WITH CHANGES from /greenlight review (claude-fable-5-1); changes applied. Platform: macOS, Chromium browsers (Chrome, Dia).

## Goal

Any local agent (Pi, Claude Code, Codex, Dar agents, scripts) can drive the user's real browser with one shell command. The browser keeps its profile, cookies, and logged-in sessions.

The UX target is the ChatGPT "Browser Use" feature:

- No token tab, no pairing step, no "connect" click for each session.
- The connection survives browser restarts and host crashes without user action.
- Each agent session gets its own tab group. User tabs stay out of reach until an agent claims one by ID.
- The agent keeps its handles (page, state) across calls.
- Agent tabs close when the agent ends its session.

The problem today: the Playwright MCP extension uses a WebSocket relay with a token. It opens a token tab on each connect, it is slow, and it drops the connection.

## Reference design (observed in ChatGPT, Nov 2026)

Source: ChatGPT extension 1.26.1102.11740, Codex `chrome` plugin 26.1103.41825.

1. Agent tool: `node_repl` MCP server, one `js` tool, persistent Node kernel.
2. Client library in the kernel: `browser-client.mjs`, `browser-service.mjs`. It gives `agent.browsers`, `tab.playwright`, and other APIs.
3. Transport: Unix socket `/tmp/codex-browser-use/<uuid>.sock`, mode 0600. Frames are a 4-byte length plus JSON.
4. Native host `ChatGPT for Chrome` (Rust). Chrome starts it with `chrome.runtime.connectNative`. It relays the socket to stdio.
5. MV3 extension. It drives tabs with `chrome.debugger` (CDP) and `chrome.tabGroups`. `minimum_chrome_version` is 116.

Host manifest: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`, `allowed_origins` = the extension IDs.

We copy the design. We do not copy code (OpenAI code is proprietary).

## Architecture

```
agent --(shell)--> buu CLI --(unix socket)--> buu host --(native messaging stdio)--> extension --(chrome.debugger)--> tabs
                                                 |
                                                 +-- kernels (one per session): playwright-core connectOverCDP
                                                 +-- CDP relay on 127.0.0.1:<random>/<secret>/<session>
```

The host process is the runtime. Chrome starts it when the extension connects. It lives as long as that connection.

### Extension (`extension/`)

- MV3, plain JS, no build step. `minimum_chrome_version` 125 (flat debugger sessions, `tabs.lastAccessed`). Fixed `key` in `manifest.json`, so the ID is the same on every machine (ID = first 32 hex chars of SHA-256 of the DER public key, mapped to a-p).
- Permissions: `debugger`, `tabs`, `tabGroups`, `nativeMessaging`, `alarms`, `storage`, `scripting` (v1.1). Host permission `<all_urls>`.
- On start: `connectNative("dev.agentropy.buu")`. On disconnect: call `connectNative` again inside `onDisconnect` first. If that fails, use backoff (1 s, 2 s, 5 s, then every 10 s) and a `chrome.alarms` fallback every 30 s (the alarms minimum).
- The action icon shows the state: connected, reconnecting, error. No popup UI in v1.
- RPC from host (JSON-RPC over the port):
  - `getInfo` → browser name, extension version, an instance ID that stays the same (kept in `storage`).
  - `listUserTabs` → all top-level tabs: id, title, url, windowId, groupId, lastAccessed.
  - `createTab {session}` → new tab, attached. Window: the window of the first session tab, else `chrome.windows.getLastFocused`. Add it to the session tab group (title `buu · <session>`) as best effort: if `chrome.tabs.group` or `tabGroups.update` fails (for example in Dia), continue without a group.
  - `claimTab {session, tabId}` → attach to a user tab. Do not move it into the group.
  - `closeTab {tabId}`, `detachTab {tabId}`.
  - `cdp {tabId, sessionId?, method, params}` → `chrome.debugger.sendCommand`.
  - `endSession {session, keep: tabId[]}` → close agent-created tabs not in `keep`, detach claimed tabs, remove the group if empty.
- Events to host: `cdpEvent`, `detached` (from `chrome.debugger.onDetach`), `tabCreated` (popup with an opener tab in a session; the extension attaches it and adds it to the group), `tabRemoved`.
- The extension refuses `chrome://`, `chrome-extension://`, and Web Store URLs.
- Debugger infobar: Chrome shows "buu is debugging this browser" on each attach. If the user clicks Cancel, Chrome detaches all tabs with reason `canceled_by_user`. The extension sends `detached` for each tab. The host marks those tabs detached and attaches again on the next command for that tab.
- If `chrome.debugger.attach` fails (for example, DevTools is open on a claimed tab), return the Chrome error text to the agent.

### Host (`host/`)

- Node 26, TypeScript run with type stripping, no build step. Two npm dependencies: `playwright-core` and `ws` (Node has a WebSocket client but no server). Do not import `playwright-core/lib/utilsBundle`.
- Native messaging on stdin/stdout. stdout carries only protocol frames. Logs go to `~/.buu/logs/host-<browser>.log`.
- Registry: on start, write `~/.buu/run/<instanceId>.json` (mode 0600) with pid, browser name, socket path, and CDP base URL. Delete it on exit. The CLI ignores entries with a dead pid.
- CLI socket: `~/.buu/run/<instanceId>.sock`, mode 0600, same frame format as native messaging.
- CDP relay: one WebSocket server on `127.0.0.1`, random port. The path is `/<128-bit secret>/<session>`. The relay makes the session's tabs look like a browser to Playwright:
  - It answers `Browser.getVersion`, `Target.setAutoAttach`, `Target.getTargets`, `Target.getTargetInfo`, `Target.setDiscoverTargets`, `Target.activateTarget`, `Target.attachToTarget`, `Target.detachFromTarget`, and `Browser.setDownloadBehavior` itself.
  - `Target.createTarget` → `createTab`, then `Target.attachedToTarget`. `Target.closeTarget` → `closeTab`.
  - Routing: no sessionId → any attached tab of the session. Relay tab session → `cdp {tabId}`. Child session → `cdp {tabId, sessionId}`. A browser-level command that needs no tab and has no answer above fails with a clear error.
  - It shows only tabs that belong to that session.
  - Reference: the Apache-2.0 relay in `microsoft/playwright`, `packages/playwright-core/src/tools/mcp/browserModel.ts`. It supports many tabs and child sessions. Copy its routing rules.
- Kernels: one `worker_threads` Worker per session, created on first use. Each kernel holds a `playwright-core` browser from `connectOverCDP(<relay url>/<session>)`, its context, and a current `page`. The relay and the native port stay in the main thread, so a sync loop in agent code freezes only its own kernel.
- `--timeout` calls `worker.terminate()` and drops the kernel. The session tabs stay open. The next call makes a new kernel that attaches to them.
- Calls to one session run one at a time. Calls to different sessions run in parallel.

### CLI (`cli/`)

`buu` is a thin client. It finds the host through `~/.buu/run/`, sends one request, prints the result, and exits.

| Command | Effect |
|---|---|
| `buu js [code]` | Run JS in the session kernel. Code comes from the argument or stdin. |
| `buu tabs` | List the user's open tabs (id, title, url). |
| `buu claim <tabId>` | Attach a user tab to the session. It becomes the current `page`. `--lent` claims the only lent tab (v1.1). |
| `buu end [--keep <tabId>...]` | End the session: close its tabs, detach claimed tabs, drop the kernel. |
| `buu status` | Connected browsers, sessions, tabs for each session. |
| `buu cdp-url` | Print the relay URL for the session, for other CDP tools. |
| `buu install` | Write the host manifest and the host wrapper. Print the extension folder for "Load unpacked". |
| `buu doctor` | Check the manifest, the wrapper, the node path, the registry, and the socket. Print a fix for each failure. |

Shared flags: `--session <name>` (default: `$BUU_SESSION`, else `default`), `--browser <name|instanceId>` (default: the only connected browser, else error with the list), `--timeout <ms>` (default 30000).

Kernel globals for `buu js`:

- `page`, `context`, `browser`: Playwright objects. `page` is the current tab. A new session opens one tab on first use.
- `state`: a plain object that persists across calls. Top-level `const`/`let` do not persist in v1.
- `print(...values)`: output to the CLI.
- `shot(opts?)`: save a screenshot of `page` to `~/.buu/shots/<session>-<n>.png` and print the path.
- `newPage()`, `usePage(p)`: open a new session tab, or set the current page.
- `handoff(message, opts?)`: ask the user to do a step in the current tab (v1.1).
- The return value of the code is printed as JSON when it is not `undefined`.
- Output cap: `print` output plus the result is capped at 200 KB. Past the cap, buu cuts the output and adds a line with the full size.

Exit code 0 on success. On an error, exit code 1 and the error message plus the first stack frame in the agent code on stderr.

### Install (`buu install`)

1. Write `~/.buu/bin/buu-host`, a shell script: `exec <absolute node path> <repo>/host/main.ts`. Chrome starts hosts with a minimal `PATH`, so the node path must be absolute.
2. Write `dev.agentropy.buu.json` (`type: stdio`, `path` = the wrapper, `allowed_origins` = our extension ID) to:
   - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (Dia reads this folder too).
   - Other Chromium folders that exist (Chrome Beta, Chromium, Brave, Edge).
   - `buu install --user-data-dir <dir>` writes to `<dir>/NativeMessagingHosts/` instead. The e2e test uses it with Chrome for Testing.
3. Print: "Load unpacked: <repo>/extension" with the `chrome://extensions` URL.

The `buu` binary comes from `npm link` in the repo (bin entry in `package.json`).

### Skill (`skill/SKILL.md`)

Short skill for agents: when to use buu (real logged-in browser, e2e checks, visual review), the commands, the kernel globals, one example flow (open, snapshot, act, screenshot, end), and the rules: claim user tabs only by ID from `buu tabs`, always `buu end` at the end.

## v1.1

Three changes. They add to v1. Where they differ, v1.1 wins. New extension permission: `scripting`.

Idea source: the "browse" project of anomalyco (MIT). We copied ideas only. We copied no code.

### Background agent tabs

- `createTab` opens the tab with `active: false`. The user keeps the view.
- When a tab joins the session group, the extension collapses the group. It skips this if the user looks at a tab of the group. It is best effort (Dia can fail).
- After each attach of an agent tab, the extension sends `Emulation.setFocusEmulationEnabled {enabled: true}`. The tab keeps rendering in the background.
- The relay answers `Page.bringToFront` with the error `buu: agents cannot raise tabs; use handoff()`. `Target.activateTarget` stays a no-op success.
- A popup that Chrome focuses by itself stays focused. buu cannot prevent this.

### Handoff

Kernel global: `await handoff(message, {timeoutMs = 600000, start?})`.

1. The kernel finds its tab. It sets a marker in the page. The host reads the marker through the extension. The kernel removes the marker.
2. The extension selects the tab (it never focuses the window) and opens its group. The user must see the tab. This is the only place where buu raises a tab.
3. The extension sets the badge `WAIT` on that tab. It shows a card: the site origin, the message, and a Continue button. The card sits in a closed shadow root. It is drawn from the isolated world with `chrome.scripting`. It uses no `innerHTML` and no `<style>`. After a page load in that tab, the extension shows the card again.
4. `start` runs after the card shows. If `start` throws, the handoff ends and `handoff` throws the same error.
5. The user clicks Continue in the card, or clicks the toolbar button on that tab. Both call one function (`continueHandoff`). The card ignores clicks that are not trusted.
6. On Continue, the extension removes the card and clears the badge. `handoff` returns `{url, title}`.
7. After `timeoutMs`, the host removes the card. `handoff` throws `handoff timed out`. The kernel stays.
8. The call timeout pauses while the handoff waits. The host pauses the kernel clock. The CLI pauses its socket clock. `buu js` needs no `--timeout` for a handoff. The time left comes back after Continue.
9. The host sends the CLI a frame `{event: "handoff"}` and later `{event: "handoffEnd"}`. The CLI prints one line on stderr: `buu: waiting for the user in tab <id>: <message>`.
10. The host ends the handoff if the CLI command ends, the kernel exits, the tab closes, or the native port closes.

A handoff is a courtesy, not a lock. Agent code can click the card with real input events.

### Lent tabs

- A toolbar click on a user tab lends it. It shows the per-tab badge `ON`. A click on an agent tab does nothing. A click on a tab with a handoff means Continue.
- The extension keeps the lent set in `chrome.storage.session`. A closed tab leaves the set.
- `buu tabs` lists lent tabs first. It ends their line with `[lent]`.
- `buu claim --lent` claims the only lent tab. It fails with the list if no tab or many tabs are lent.
- A claimed tab shows `RUN` while a `buu js` call of its session runs. Then it shows `ON` again.
- `buu end` detaches a claimed tab. If the tab is lent, it stays lent.
- A toolbar click on a lent or claimed tab takes it back. The extension detaches the debugger, drops the tab from the session, and clears the badge. The host stops the running call (it ends the kernel). The next `buu js` call of that session fails once with `the user took tab <id> back`.
- The relay refuses `Target.closeTarget` and `Page.close` for a lent or claimed tab. `buu end` never closes it. Playwright `page.close()` hides the refusal and waits. The tab stays open.
- The global badge (`on`, `...`, `!`) shows the connection. A per-tab badge overrides it on its tab only. Without a per-tab state, the tab shows the global badge.

### Test hook

Nobody can click the toolbar in headless Chrome. The extension has test methods named `test.*`. The host forwards them only if `BUU_TEST=1` is in its environment. The CLI reaches them with the hidden command `buu __test <method> [json]`. It is not in `buu help`. The toolbar click goes through `onToolbarClick`. Both Continue paths go through `continueHandoff`.

## Non-goals for v1

Windows and Linux. An MCP server. ChatGPT-style AX, CUA, and DOM-CUA APIs. History, bookmarks, and downloads APIs. Network policy. Approval prompts. Agent cursor overlay. Side panel. Web Store release. Persistent top-level bindings.

## Premises (verified by the review)

| Premise | Status | Evidence |
|---|---|---|
| Dia reads the Chrome host folder | Confirmed | Dia is the parent process of the ChatGPT host. Arc patch strings in `Dia.app/.../ArcCore`. |
| An open native port keeps the MV3 worker alive | Confirmed | Chrome 105+ (native ports), 118+ (debugger sessions). Service worker lifecycle docs. |
| `sendCommand` accepts a child `sessionId` | Confirmed | Chrome 125+, `DebuggerSession` type. |
| `connectOverCDP` works through a partial relay | Confirmed | playwright-core `crBrowser.js`. Upstream `browserModel.ts` relay. |
| Chrome for Testing: `--load-extension` + host manifest | Confirmed by test | CfT 156 in `~/Library/Caches/ms-playwright/chromium-1248`. Manifest in `<user-data-dir>/NativeMessagingHosts/`. |
| A fixed `key` gives a fixed ID | Confirmed by test | The host got `chrome-extension://<computed id>/`. |

## Acceptance tests

1. `buu install`, then `buu doctor` shows all checks green.
2. Load the extension in Chrome and in Dia. `buu status` lists both browsers. No tab opens.
3. `buu js "await page.goto('https://example.com'); return await page.title()"` prints `"Example Domain"`. The tab is in the group `buu · default`.
4. A second `buu js "return page.url()"` prints the same URL. `state.x = 1` in one call is readable in the next call.
5. Two sessions (`--session a`, `--session b`) run in parallel, each in its own tab group.
6. `buu tabs` lists user tabs. `buu claim <id>` makes that tab the `page`. The tab stays out of the group.
7. `buu end` closes the session tabs, detaches the claimed tab, and leaves the claimed tab open.
8. Quit and restart the browser. `buu status` shows it again with no user action. Kill the host process. The extension starts it again within 15 s.
9. `buu js "await shot()"` prints a PNG path. The file opens.
10. An e2e test runs steps 3 to 7 on Chrome for Testing (`--headless=new --user-data-dir=<tmp> --load-extension`), with the manifest from `buu install --user-data-dir <tmp>`.

## Build order

1. Extension + host handshake (`getInfo`), registry, `buu status`, `buu install`, `buu doctor`.
2. CDP relay + kernel + `buu js` for one session, one tab.
3. More sessions, tab groups, popups, `buu tabs`, `buu claim`, `buu end`.
4. Reconnect, logs, `shot()`, skill.
5. e2e test.
