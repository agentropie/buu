---
name: buu
description: Drive the user's real, logged-in Chromium browser (Chrome, Dia) from the shell with the `buu` CLI. Use for e2e checks of a web app, visual review with screenshots, or any task that needs the user's cookies and sessions. Not for headless scraping that needs no login.
---

# buu

`buu` runs Playwright code in the user's real browser. The browser keeps its profile and logins. Each agent session gets its own tab group.

## Install

Source: https://github.com/agentropie/buu. If `buu` is not installed or `buu doctor` fails, install it with these commands:

```sh
git clone https://github.com/agentropie/buu ~/code/buu && cd ~/code/buu
npm install && npm link && buu install
```

Then ask the user to load the `extension/` folder unpacked in `chrome://extensions` (Developer mode). Only the user can do this step. The README has the full steps.

## Commands

| Command | Effect |
|---|---|
| `buu js "<code>"` | Run JS in your session kernel. Code can also come from stdin. |
| `buu tabs` | List the user's tabs: `id`, title, URL. |
| `buu claim <tabId>` | Attach a user tab to your session. It becomes `page`. |
| `buu claim --lent` | Attach the one tab the user lent. Fails if none or many are lent. |
| `buu end [--keep <tabId>...]` | Close your tabs, detach claimed tabs, drop the kernel. |
| `buu status` | Show browsers, sessions, and tabs. |
| `buu cdp-url` | Print the CDP URL of the session for other CDP tools. |
| `buu doctor` | Check the install. Prints a fix for each failure. |

Flags: `--session <name>` (default `$BUU_SESSION`, else `default`), `--browser <name|instanceId>` (needed only if many browsers are connected), `--timeout <ms>` (default 30000).

Use a unique session name for each task, for example `--session review-login`. Or set `BUU_SESSION` once.

## Globals in `buu js`

- `page`, `context`, `browser`: Playwright objects. `page` is the current tab. The first call opens a tab.
- `state`: a plain object. It persists across calls. Top-level `const` and `let` do not persist.
- `print(...values)`: write to the output. `console.log` does the same.
- `shot(opts?)`: save a screenshot of `page` to `~/.buu/shots/<session>-<n>.png` and print the path. Read the PNG to see it.
- `handoff(message, {timeoutMs = 600000, start})`: ask the user to do a step in the current tab. It waits for Continue. It returns `{url, title}`. See "Handoff".
- `newPage()`: open a new session tab and make it `page`. `usePage(p)`: make `p` the current page.
- The return value prints as JSON (a string prints with quotes). Use `print` for plain text. Output is cut at 200 KB.

On an error buu exits with code 1. stderr has the message and the line in your code.

## Example

```sh
export BUU_SESSION=check-login
buu js "await page.goto('https://example.com/login'); return await page.title()"
buu js "print(await page.locator('body').ariaSnapshot())"       # read the page
buu js "await page.getByLabel('Email').fill('a@b.c'); await page.getByRole('button', {name: 'Sign in'}).click()"
buu js "await shot()"                                          # prints the PNG path
buu end
```

## Handoff

Use `handoff` for a step only the user can do: a login, a captcha, a permission prompt, a payment.

1. Tell the user in chat first. Say which tab and what to do. The tab comes to the front when you call `handoff`.
2. Call `handoff("Sign in, then click Continue")`. Write a short message. It shows on a card in the page.
3. Do not pass `--timeout` for it. The call timeout pauses while the user acts. `timeoutMs` (default 10 minutes) sets the wait. After it, `handoff` throws `handoff timed out`.
4. After it returns, check the result. Check the URL or an element on the page. Do not assume the step worked.
5. `start` is an optional async function. It runs after the card shows. Use it for a click that opens a prompt.

```sh
buu js "await page.goto('https://example.com/login'); await handoff('Sign in, then click Continue'); return page.url()"
```

The user can also lend a tab with the toolbar button. Prefer `buu claim --lent` to a guessed ID. The user can take a lent tab back at any time. Then the running call stops. The next call fails once with "the user took tab <id> back". Do not claim it again. Ask the user.

## Rules

1. Claim a user tab only by an ID from `buu tabs`. Never guess an ID. Claim only if the user asked, or the task needs their open page.
2. Always run `buu end` when you finish. It closes your tabs. It leaves claimed tabs open.
3. Do not touch tabs that are not yours. Do not navigate a claimed tab away unless the task needs it.
4. A timeout drops the kernel, so `state` is lost. The tabs stay open. Raise `--timeout` for slow steps.
5. buu refuses `chrome://`, `chrome-extension://`, and Web Store URLs.
6. Prefer `context.on('page')` or `context.waitForEvent('page')` for popups. `page.on('popup')` does not fire.
7. Chrome shows "buu is debugging this browser". If the user clicks Cancel, buu attaches again on the next call.
8. Never raise a tab. `page.bringToFront()` fails by design. Use `handoff` when the user must see a tab.
9. Never close a lent or claimed tab. buu refuses it.
10. Do not run two clients on the same session at once. A second kernel or CDP client takes over the tabs.
