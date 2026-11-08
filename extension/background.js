// buu extension: service worker. Talks to the native host over one native port.
// The host sends JSON-RPC requests {id, method, params}. We answer {id, result} or {id, error}.
// We send events as {event, ...}.

const HOST = 'dev.agentropy.buu';
const BACKOFF_MS = [1000, 2000, 5000, 10000];
const HEALTHY_MS = 5000; // a port that lived this long counts as a healthy connection
const GROUP_COLORS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'yellow', 'red'];

/** @type {chrome.runtime.Port | null} */
let port = null;
let attempt = 0;
let retryTimer = null;

// session name -> { agent: number[], claimed: number[], groupId: number | null }
let sessions = {};
// tab ids with our debugger attached
const attached = new Set();
// Tabs that got CDP commands from a client. A new client must not inherit their enabled domains.
const used = new Set();
let instanceId = '';
// Tabs the user lent by a toolbar click. Kept in storage.session.
const lent = new Set();
// Sessions that run a `buu js` call now. Their claimed tabs show RUN.
const running = new Set();
let globalColor = '#9a6700';

function log(...args) {
  console.log('[buu]', ...args);
  send({ event: 'log', message: args.map((a) => (typeof a === 'string' ? a : String(a?.message ?? JSON.stringify(a)))).join(' ') });
}

// ---------- state ----------

const ready = (async () => {
  const local = await chrome.storage.local.get('instanceId');
  instanceId = local.instanceId;
  if (!instanceId) {
    instanceId = crypto.randomUUID().replaceAll('-', '');
    await chrome.storage.local.set({ instanceId });
  }
  const stored = await chrome.storage.session.get('sessions');
  sessions = stored.sessions ?? {};
  for (const id of (await chrome.storage.session.get('lent')).lent ?? []) lent.add(id);
  // After a worker restart, debugger sessions of our tabs stay attached.
  const targets = await chrome.debugger.getTargets();
  const mine = new Set(Object.values(sessions).flatMap((s) => [...s.agent, ...s.claimed]));
  for (const t of targets) {
    if (t.attached && t.tabId !== undefined && mine.has(t.tabId)) {
      attached.add(t.tabId);
      used.add(t.tabId);
    }
  }
  for (const id of [...lent, ...mine]) refreshBadge(id);
})();

function save() {
  return chrome.storage.session.set({ sessions });
}

function saveLent() {
  return chrome.storage.session.set({ lent: [...lent] });
}

function claimedBy(tabId) {
  return Object.entries(sessions).find(([, s]) => s.claimed.includes(tabId))?.[0];
}

function sessionOf(tabId) {
  for (const [name, s] of Object.entries(sessions)) {
    if (s.agent.includes(tabId) || s.claimed.includes(tabId)) return name;
  }
  return undefined;
}

function isAgentTab(tabId) {
  return Object.values(sessions).some((s) => s.agent.includes(tabId));
}

function ensureSession(name) {
  return (sessions[name] ??= { agent: [], claimed: [], groupId: null });
}

// ---------- action icon ----------

function setState(state, detail) {
  const map = {
    connected: ['on', '#1a7f37', 'buu: connected'],
    connecting: ['...', '#9a6700', 'buu: connecting'],
    reconnecting: ['...', '#9a6700', 'buu: reconnecting'],
    error: ['!', '#cf222e', `buu: error${detail ? ` (${detail})` : ''}`],
  };
  const [text, color, title] = map[state];
  globalColor = color;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

// Per-tab badge. It overrides the global badge on that tab only. No state: use the global badge.
function refreshBadge(tabId) {
  const owner = claimedBy(tabId);
  let text = null;
  let color = '#0969da';
  if (owner && running.has(owner)) {
    text = 'RUN';
    color = '#bc4c00';
  } else if (owner || lent.has(tabId)) {
    text = 'ON';
    color = '#1a7f37';
  }
  // text null clears the tab value. Then the global badge shows again.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: text ? color : globalColor }).catch(() => {});
}

// ---------- native port ----------

function send(msg) {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (e) {
    console.log('[buu] postMessage failed', e); // not log(): log calls send
  }
}

function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    attempt++;
    setState('error', String(e?.message ?? e));
    scheduleRetry();
    return;
  }
  port = p;
  const startedAt = Date.now();
  let greeted = false;
  p.onMessage.addListener((msg) => {
    if (!greeted) {
      greeted = true;
      attempt = 0;
      setState('connected');
    }
    onHostMessage(msg);
  });
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (port === p) port = null;
    if (Date.now() - startedAt >= HEALTHY_MS) {
      // Host crash or browser-side restart. Reconnect at once. This starts a new host.
      attempt = 0;
      setState('reconnecting');
      connect();
    } else {
      attempt++;
      setState('error', err);
      scheduleRetry();
    }
  });
  setState('connecting');
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 10000;
  retryTimer = setTimeout(connect, delay);
}

chrome.alarms.create('buu-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'buu-keepalive' && !port) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

async function onHostMessage(msg) {
  if (msg == null || msg.id === undefined) return;
  try {
    await ready;
    const handler = rpc[msg.method];
    if (!handler) throw new Error(`unknown method ${msg.method}`);
    const result = await handler(msg.params ?? {});
    send({ id: msg.id, result: result ?? null });
  } catch (e) {
    send({ id: msg.id, error: String(e?.message ?? e) });
  }
}

// ---------- tab helpers ----------

const BLOCKED = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^chrome-untrusted:\/\//i,
  /^devtools:\/\//i,
  /^https:\/\/chromewebstore\.google\.com(\/|$)/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
];

function checkUrl(url) {
  if (url && BLOCKED.some((re) => re.test(url))) {
    throw new Error(`buu refuses to touch this URL: ${url}`);
  }
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  if (isAgentTab(tabId)) {
    // A background tab must render. Without this, screenshots, rAF, and timers can stall.
    await chrome.debugger
      .sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch((e) => log('focus emulation failed', e));
  }
}

async function detach(tabId) {
  attached.delete(tabId);
  used.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

async function addToGroup(name, sess, tabId, windowId) {
  try {
    if (sess.groupId != null) {
      try {
        await chrome.tabGroups.get(sess.groupId);
        await chrome.tabs.group({ tabIds: [tabId], groupId: sess.groupId });
        return;
      } catch {}
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    await chrome.tabGroups.update(groupId, { title: `buu \u00b7 ${name}`, color: GROUP_COLORS[h % GROUP_COLORS.length] });
    sess.groupId = groupId;
  } catch (e) {
    log('tab group failed (continuing without a group)', e);
  }
}

// Keep the session group out of the way. Skip it when the user looks at a tab of the group.
async function collapseGroup(sess) {
  if (sess.groupId == null) return;
  try {
    const looking = await chrome.tabs.query({ active: true, groupId: sess.groupId });
    if (looking.length) return;
    await chrome.tabGroups.update(sess.groupId, { collapsed: true });
  } catch (e) {
    log('collapse group failed (continuing)', e);
  }
}

async function sessionWindowId(sess) {
  for (const id of [...sess.agent, ...sess.claimed]) {
    try {
      return (await chrome.tabs.get(id)).windowId;
    } catch {}
  }
  try {
    return (await chrome.windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

async function tabDetail(tabId, groupTitles) {
  try {
    const t = await chrome.tabs.get(tabId);
    return {
      id: t.id,
      title: t.title ?? '',
      url: t.url ?? t.pendingUrl ?? '',
      windowId: t.windowId,
      groupId: t.groupId ?? -1,
      groupTitle: groupTitles.get(t.groupId) ?? null,
    };
  } catch {
    return null;
  }
}

async function groupTitleMap() {
  const m = new Map();
  try {
    for (const g of await chrome.tabGroups.query({})) m.set(g.id, g.title ?? '');
  } catch {}
  return m;
}

// ---------- toolbar click ----------

// One function for every toolbar click. The e2e test calls it through `test.toolbarClick`.
async function onToolbarClick(tab) {
  await ready;
  const tabId = tab.id;
  if (tabId === undefined) return;
  if (isAgentTab(tabId)) return; // agent tabs have no toolbar action
  if (lent.has(tabId) || claimedBy(tabId)) return await takeBack(tabId);
  try {
    const t = await chrome.tabs.get(tabId);
    checkUrl(t.url ?? t.pendingUrl);
  } catch (e) {
    log('lend refused', e);
    return;
  }
  lent.add(tabId);
  await saveLent();
  refreshBadge(tabId);
}

// The user takes a lent or claimed tab back. Detach, leave the session, tell the host.
async function takeBack(tabId) {
  const owner = claimedBy(tabId);
  lent.delete(tabId);
  await saveLent();
  if (owner) {
    sessions[owner].claimed = sessions[owner].claimed.filter((i) => i !== tabId);
    await detach(tabId);
    await save();
    send({ event: 'takenBack', tabId, session: owner });
  }
  refreshBadge(tabId);
}

chrome.action.onClicked.addListener((tab) => void onToolbarClick(tab));

// Chrome can reset tab badges on navigation. Apply them again.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' || info.status === 'complete') refreshBadge(tabId);
});

function assertClosable(tabId) {
  if (lent.has(tabId) || claimedBy(tabId)) throw new Error('buu: agents cannot close a lent or claimed tab');
}

// ---------- RPC ----------

const rpc = {
  async getInfo() {
    const brands = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? [];
    return {
      instanceId,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      brands,
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([n, s]) => [n, { agent: s.agent, claimed: s.claimed }]),
      ),
    };
  },

  async getState() {
    const titles = await groupTitleMap();
    const out = {};
    for (const [name, s] of Object.entries(sessions)) {
      const tabs = [];
      for (const id of s.agent) {
        const d = await tabDetail(id, titles);
        if (d) tabs.push({ ...d, claimed: false, attached: attached.has(id) });
      }
      for (const id of s.claimed) {
        const d = await tabDetail(id, titles);
        if (d) tabs.push({ ...d, claimed: true, attached: attached.has(id) });
      }
      out[name] = { tabs };
    }
    return { sessions: out };
  },

  async listUserTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        id: t.id,
        title: t.title ?? '',
        url: t.url ?? t.pendingUrl ?? '',
        windowId: t.windowId,
        groupId: t.groupId ?? -1,
        lastAccessed: t.lastAccessed ?? 0,
        session: sessionOf(t.id) ?? null,
        claimed: Object.values(sessions).some((s) => s.claimed.includes(t.id)),
        lent: lent.has(t.id),
      }));
  },

  async createTab({ session, url }) {
    const sess = ensureSession(session);
    const target = url || 'about:blank';
    checkUrl(target);
    const windowId = await sessionWindowId(sess);
    // The tab joins the session in the same promise. onCreated waits for it (see below).
    const creation = chrome.tabs
      .create({ url: target, active: false, ...(windowId !== undefined ? { windowId } : {}) })
      .then((t) => {
        sess.agent.push(t.id);
        return t;
      });
    creating.add(creation);
    let tab;
    try {
      tab = await creation;
    } finally {
      creating.delete(creation);
    }
    await save();
    try {
      await attach(tab.id);
    } catch (e) {
      sess.agent = sess.agent.filter((i) => i !== tab.id);
      await save();
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw e;
    }
    await addToGroup(session, sess, tab.id, tab.windowId);
    await collapseGroup(sess);
    return { tabId: tab.id, windowId: tab.windowId };
  },

  async claimTab({ session, tabId }) {
    const tab = await chrome.tabs.get(tabId).catch(() => {
      throw new Error(`no tab with id ${tabId}`);
    });
    checkUrl(tab.url ?? tab.pendingUrl);
    const owner = sessionOf(tabId);
    if (owner) throw new Error(`tab ${tabId} already belongs to session "${owner}"`);
    await attach(tabId);
    ensureSession(session).claimed.push(tabId);
    await save();
    refreshBadge(tabId);
    return { tabId, url: tab.url ?? '', title: tab.title ?? '' };
  },

  async attachTab({ tabId }) {
    // A new client (kernel) takes over a tab an old client used. Start from a clean debugger session.
    // Else Runtime.enable sends no execution contexts and page.evaluate hangs.
    const fresh = attached.has(tabId) && used.has(tabId);
    if (fresh) await detach(tabId);
    await attach(tabId);
    return { fresh };
  },

  async assertClosable({ tabId }) {
    assertClosable(tabId);
    return {};
  },

  async setRunning({ session, running: on }) {
    if (on) running.add(session);
    else running.delete(session);
    for (const id of sessions[session]?.claimed ?? []) refreshBadge(id);
    return {};
  },

  async closeTab({ tabId }) {
    assertClosable(tabId);
    await detach(tabId);
    for (const s of Object.values(sessions)) {
      s.agent = s.agent.filter((i) => i !== tabId);
      s.claimed = s.claimed.filter((i) => i !== tabId);
    }
    await save();
    await chrome.tabs.remove(tabId).catch(() => {});
    return {};
  },

  async detachTab({ tabId }) {
    await detach(tabId);
    for (const s of Object.values(sessions)) {
      s.agent = s.agent.filter((i) => i !== tabId);
      s.claimed = s.claimed.filter((i) => i !== tabId);
    }
    await save();
    refreshBadge(tabId);
    return {};
  },

  async cdp({ tabId, sessionId, method, params }) {
    if (!attached.has(tabId)) await attach(tabId); // re-attach after the user clicked Cancel
    if (method !== 'Target.getTargetInfo') used.add(tabId);
    const target = sessionId ? { tabId, sessionId } : { tabId };
    return await chrome.debugger.sendCommand(target, method, params);
  },

  // Test-only. The host exposes these only when BUU_TEST=1.
  async 'test.toolbarClick'({ tabId }) {
    await onToolbarClick({ id: tabId });
    return {};
  },

  async 'test.badge'({ tabId }) {
    return { text: await chrome.action.getBadgeText({ tabId }) };
  },

  async 'test.tabs'() {
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({}).catch(() => []);
    return {
      tabs: tabs.map((t) => ({ id: t.id, active: t.active, windowId: t.windowId, groupId: t.groupId, url: t.url ?? '' })),
      groups: groups.map((g) => ({ id: g.id, title: g.title, collapsed: g.collapsed })),
    };
  },

  async endSession({ session, keep = [] }) {
    const sess = sessions[session];
    const result = { closed: [], detached: [], kept: [] };
    if (!sess) return result;
    for (const id of sess.agent) {
      if (keep.includes(id)) {
        await detach(id);
        await chrome.tabs.ungroup(id).catch(() => {});
        result.kept.push(id);
      } else {
        await detach(id);
        await chrome.tabs.remove(id).catch(() => {});
        result.closed.push(id);
      }
    }
    for (const id of sess.claimed) {
      await detach(id);
      result.detached.push(id);
    }
    delete sessions[session];
    running.delete(session);
    await save();
    for (const id of result.detached) refreshBadge(id);
    return result;
  },
};

// ---------- events to the host ----------

// Page.windowOpen names the real opener. tab.openerTabId can be wrong (headless reports the active tab).
const recentOpens = []; // { session, at, url }
const creating = new Set(); // tabs.create calls in flight. Their onCreated can arrive before the tab id is known.

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !sessionOf(source.tabId)) return;
  if (method === 'Page.windowOpen' && !source.sessionId) {
    recentOpens.push({ session: sessionOf(source.tabId), at: Date.now(), url: params?.url });
  }
  send({ event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  used.delete(source.tabId);
  if (sessionOf(source.tabId)) send({ event: 'detached', tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  used.delete(tabId);
  if (lent.delete(tabId)) await saveLent();
  const name = sessionOf(tabId);
  if (!name) return;
  const s = sessions[name];
  s.agent = s.agent.filter((i) => i !== tabId);
  s.claimed = s.claimed.filter((i) => i !== tabId);
  await save();
  send({ event: 'tabRemoved', tabId, session: name });
});

// Popups opened by a session tab join the session.
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  // Our own tabs.create calls started before this event. Wait until they put their tab in a session.
  // The tab URL is empty for a popup here, so matching by URL does not work.
  await Promise.allSettled([...creating]);
  if (tab.id === undefined || sessionOf(tab.id)) return;
  const freshOpen = () => {
    while (recentOpens.length && Date.now() - recentOpens[0].at > 3000) recentOpens.shift();
    return recentOpens.shift();
  };
  let open = freshOpen();
  // Page.windowOpen can arrive after onCreated. Wait a short time when the tab has an opener.
  for (let i = 0; !open && tab.openerTabId !== undefined && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    open = freshOpen();
  }
  if (sessionOf(tab.id)) return;
  const name = open?.session ?? (tab.openerTabId !== undefined ? sessionOf(tab.openerTabId) : undefined);
  log(`onCreated tab ${tab.id} opener=${tab.openerTabId} windowOpen=${open?.session} -> session ${name}`);
  if (!name) return;
  const sess = sessions[name];
  try {
    checkUrl(tab.url ?? tab.pendingUrl);
    sess.agent.push(tab.id);
    await save();
    await attach(tab.id);
    await addToGroup(name, sess, tab.id, tab.windowId);
    await collapseGroup(sess);
    send({ event: 'tabCreated', session: name, tabId: tab.id });
  } catch (e) {
    log('popup attach failed', e);
  }
});

setState('connecting');
connect();
