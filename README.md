# buu

Browser Uber Use. Lets any local agent use your real Chromium browser (Chrome, Dia, ...) through a browser extension.

## Parts

- `extension/`: MV3 extension. Drives tabs with `chrome.debugger` (CDP). Keeps each agent session in its own tab group.
- `host/`: native messaging host. Chrome starts it. It relays messages between the extension and a local Unix socket.
- `cli/`: `buu` command for agents. Connects to the socket and gives a Playwright page for a tab.
- `skill/`: agent skill that shows how to use `buu`.

## Why native messaging

Chrome starts the host and checks the extension ID in the host manifest. No token, no pairing tab, no open network port.
