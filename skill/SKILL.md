---
name: buu
description: Drive the user's real, logged-in Chromium browser (Chrome, Dia) from the shell with the `buu` CLI. Use for e2e checks of a web app, visual review with screenshots, or any task that needs the user's cookies and sessions. Not for headless scraping that needs no login.
---

# buu

`buu` runs Playwright code in the user's real browser. The browser keeps its profile and logins. Each agent session gets its own tab group.

## Commands

| Command | Effect |
|---|---|
| `buu js "<code>"` | Run JS in your session kernel. Code can also come from stdin. |
| `buu tabs` | List the user's tabs: `id`, title, URL. |
| `buu claim <tabId>` | Attach a user tab to your session. It becomes `page`. |
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

## Rules

1. Claim a user tab only by an ID from `buu tabs`. Never guess an ID. Claim only if the user asked, or the task needs their open page.
2. Always run `buu end` when you finish. It closes your tabs. It leaves claimed tabs open.
3. Do not touch tabs that are not yours. Do not navigate a claimed tab away unless the task needs it.
4. A timeout drops the kernel, so `state` is lost. The tabs stay open. Raise `--timeout` for slow steps.
5. buu refuses `chrome://`, `chrome-extension://`, and Web Store URLs.
6. Prefer `context.on('page')` or `context.waitForEvent('page')` for popups. `page.on('popup')` does not fire.
7. Chrome shows "buu is debugging this browser". If the user clicks Cancel, buu attaches again on the next call.
8. Do not run two clients on the same session at once. A second kernel or CDP client takes over the tabs.
