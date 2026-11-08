# buu

Browser Uber Use. Lets any local agent use your real Chromium browser (Chrome, Dia, ...) through a browser extension.

Spec: [docs/spec.md](docs/spec.md). Platform: macOS. Needs Node 24 or newer (developed on Node 26).

## Parts

- `extension/`: MV3 extension. Drives tabs with `chrome.debugger` (CDP). Keeps each agent session in its own tab group.
- `host/`: native messaging host. Chrome starts it. It runs the CDP relay and one `playwright-core` kernel for each session.
- `cli/`: `buu` command for agents. Talks to the host over a Unix socket.
- `skill/SKILL.md`: agent skill that shows how to use `buu`.

## Install

1. Install dependencies and the `buu` command:

   ```sh
   npm install
   npm link
   ```

2. Write the native host manifest:

   ```sh
   buu install
   ```

   This writes `~/.buu/bin/buu-host` and `dev.agentropy.buu.json` into the `NativeMessagingHosts` folder of Chrome (Dia reads it too). It also writes into Chrome Beta, Chromium, Brave, and Edge if they exist.

3. Load the extension. Open `chrome://extensions` (or `dia://extensions`), turn on Developer mode, click "Load unpacked", and pick the `extension/` folder. The extension ID is the same on every machine.

4. Check the result:

   ```sh
   buu doctor      # every line shows ✓
   buu status      # lists the connected browser
   buu js "await page.goto('https://example.com'); return await page.title()"
   buu end
   ```

To let agents use the skill, link `skill/` into the skills folder of your agent, for example `ln -s "$PWD/skill" ~/.agents/skills/buu`.

## Use

```sh
buu js "<code>"          # run Playwright code in your session
buu tabs                 # list your open tabs
buu claim <tabId>        # use one of your tabs
buu end                  # close the session tabs
```

See `skill/SKILL.md` for the globals (`page`, `state`, `print`, `shot`, ...) and the rules.

## Files and logs

| Path | Content |
|---|---|
| `~/.buu/run/` | One registry file and one socket for each connected browser |
| `~/.buu/logs/host-<browser>.log` | Host log. Set `BUU_DEBUG=1` in the browser environment for CDP traces. |
| `~/.buu/shots/` | Screenshots from `shot()` |
| `~/.buu/bin/buu-host` | Wrapper that Chrome starts |

Set `BUU_HOME` to use another folder. Unix socket paths have a 104-byte limit on macOS, so keep it short.

## Development

```sh
npm run typecheck
npm test        # e2e on Chrome for Testing, headless, temp profile
```

The e2e test needs Chrome for Testing in `~/Library/Caches/ms-playwright/chromium-*` (or `BUU_CHROME=<path to binary>`). It never touches your own browsers. It uses `buu install --user-data-dir <tmp>` and a temp `BUU_HOME`. Set `BUU_E2E_KEEP=1` to keep the temp folder.

After you change `extension/`, reload it in `chrome://extensions`. Chrome can keep the old service worker for a reused profile.

The extension private key is not in the repo. Keep it in `~/.buu/extension-key.pem`. The public key is in `extension/manifest.json`.

## Why native messaging

Chrome starts the host and checks the extension ID in the host manifest. No token, no pairing tab, no open network port for other users. The CDP relay listens on `127.0.0.1` and needs a 128-bit secret in the URL.

## Known limits

- `page.on('popup')` does not fire. Use `context.waitForEvent('page')`.
- One client at a time for each session. A second kernel resets the debugger session of the tabs.
- A message to Chrome is at most 1 MB (native messaging limit).
- Chrome shows "buu is debugging this browser" on attached tabs.
