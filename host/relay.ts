// CDP relay. Makes the tabs of one buu session look like a browser to Playwright.
// Routing rules follow the Apache-2.0 relay in microsoft/playwright
// (packages/playwright-core/src/tools/mcp/browserModel.ts).
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hub, Session } from './hub.ts';

const DEBUG = !!process.env.BUU_DEBUG;

type CdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};

type TabSession = {
  tabId: number;
  sessionId: string;
  targetInfo: any;
  children: Set<string>; // child sessions (workers, oopifs) of this tab
  // Events held back until the Page.getFrameTree answer reaches Playwright (see #onCommand).
  hold?: CdpMessage[];
};

export class Relay {
  readonly secret = randomBytes(16).toString('hex');
  port = 0;
  #server: Server;
  #wss: WebSocketServer;

  #hub: Hub;

  constructor(hub: Hub) {
    this.#hub = hub;
    this.#server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.#wss = new WebSocketServer({ noServer: true });
    this.#server.on('upgrade', (req, socket, head) => {
      const m = /^\/([0-9a-f]{32})\/([A-Za-z0-9._-]{1,64})$/.exec(req.url ?? '');
      if (!m || m[1] !== this.secret || req.headers.origin) {
        socket.destroy();
        return;
      }
      const name = m[2];
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = new RelayConn(ws, this.#hub, this.#hub.session(name));
        conn.start();
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => {
        this.port = (this.#server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  get base(): string {
    return `ws://127.0.0.1:${this.port}/${this.secret}`;
  }

  close() {
    this.#server.close();
    for (const c of this.#wss.clients) c.terminate();
  }
}

export class RelayConn {
  #tabs = new Map<number, TabSession>();
  #attaching = new Map<number, Promise<TabSession>>();
  #autoAttach = false;
  #nextSession = 1;
  /** Tabs Chrome detached for a reason other than closing. Re-attached on the next call. */
  #lost = new Set<number>();

  readonly ws: WebSocket;
  readonly hub: Hub;
  readonly session: Session;

  constructor(ws: WebSocket, hub: Hub, session: Session) {
    this.ws = ws;
    this.hub = hub;
    this.session = session;
  }

  start() {
    this.session.conns.add(this);
    this.ws.on('message', (data) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this.ws.close();
        return;
      }
      void this.#onCommand(msg);
    });
    this.ws.on('close', () => this.session.conns.delete(this));
    this.ws.on('error', () => this.session.conns.delete(this));
  }

  close() {
    this.session.conns.delete(this);
    this.ws.terminate();
  }

  #send(msg: CdpMessage) {
    if (DEBUG) this.hub.log(`relay[${this.session.name}] ->`, msg.sessionId ?? '', msg.method ?? `#${msg.id}`, msg.error?.message ?? '');
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async #onCommand(msg: CdpMessage) {
    const { id, method, params, sessionId } = msg;
    if (id === undefined || !method) return;
    if (DEBUG) this.hub.log(`relay[${this.session.name}] <-`, sessionId ?? '', method, `#${id}`);
    // The extension can deliver a late-attached tab's events before the command answers.
    // Playwright drops lifecycle and execution context events for frames it does not know yet.
    // It learns the frames from Page.getFrameTree. So we hold the tab's events until that answer is out.
    const held = method === 'Page.getFrameTree' ? [...this.#tabs.values()].find((t) => t.sessionId === sessionId) : undefined;
    if (held) held.hold = [];
    try {
      const result = await this.#handle(method, params, sessionId);
      this.#send({ id, sessionId, result: result ?? {} });
    } catch (e) {
      this.#send({ id, sessionId, error: { message: String((e as Error)?.message ?? e) } });
    }
    if (held?.hold) {
      const queued = held.hold;
      held.hold = undefined;
      for (const m of queued) this.#send(m);
    }
  }

  async #handle(method: string, params: any, sessionId: string | undefined): Promise<any> {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${this.hub.chromeVersion}`,
          revision: '0',
          userAgent: this.hub.userAgent,
          jsVersion: '',
        };
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
      case 'Target.setDiscoverTargets':
      case 'Target.activateTarget':
      case 'Target.detachFromTarget':
        return {};
      case 'Page.close': {
        // The extension refuses this for a lent or claimed tab. Release it, so page.close() returns.
        const { tabId } = this.#target(method, sessionId);
        if (await this.#releaseIfProtected(tabId)) return {};
        break;
      }
      case 'Page.bringToFront':
        throw new Error('buu: agents cannot raise tabs; use handoff()');
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
        throw new Error('buu: extra browser contexts are not supported. Use context.newPage().');
      case 'Target.setAutoAttach':
        if (sessionId) break;
        await this.#enableAutoAttach();
        return {};
      case 'Target.getTargets':
        return { targetInfos: [...this.#tabs.values()].map((t) => ({ ...t.targetInfo, attached: true })) };
      case 'Target.getTargetInfo':
        if (sessionId) break;
        return { targetInfo: { targetId: 'buu-browser', type: 'browser', title: '', url: '', attached: true } };
      case 'Target.attachToTarget': {
        const ts = [...this.#tabs.values()].find((t) => t.targetInfo?.targetId === params?.targetId);
        if (!ts) throw new Error(`No target with id ${params?.targetId} in this session`);
        return { sessionId: ts.sessionId };
      }
      case 'Target.createTarget':
        return await this.#createTarget(params?.url);
      case 'Target.closeTarget': {
        const ts = [...this.#tabs.values()].find((t) => t.targetInfo?.targetId === params?.targetId);
        if (!ts) return { success: false };
        if (await this.#releaseIfProtected(ts.tabId)) return { success: true };
        await this.hub.closeTab(this.session, ts.tabId);
        return { success: true };
      }
    }
    const target = this.#target(method, sessionId);
    return await this.hub.ext.call('cdp', { ...target, method, params });
  }

  /** A lent or claimed tab stays open. The agent loses it instead. Returns true when it did. */
  async #releaseIfProtected(tabId: number): Promise<boolean> {
    try {
      await this.hub.ext.call('assertClosable', { tabId });
      return false;
    } catch {
      await this.hub.releaseTab(tabId);
      return true;
    }
  }

  // 1. no sessionId: browser-level command. Route through any attached tab of the session.
  // 2. relay tab session: route by tab id.
  // 3. child session (worker, oopif): route to the owning tab and keep the sessionId.
  #target(method: string, sessionId: string | undefined): { tabId: number; sessionId?: string } {
    if (!sessionId) {
      const first = this.#tabs.values().next().value;
      if (!first) throw new Error(`No attached tab to forward browser-level command: ${method}`);
      return { tabId: first.tabId };
    }
    for (const t of this.#tabs.values()) if (t.sessionId === sessionId) return { tabId: t.tabId };
    for (const t of this.#tabs.values()) if (t.children.has(sessionId)) return { tabId: t.tabId, sessionId };
    throw new Error(`No tab found for sessionId: ${sessionId}`);
  }

  async #enableAutoAttach() {
    this.#autoAttach = true;
    await Promise.all([...this.session.tabs.keys()].map((id) => this.attachTab(id).catch((e) => this.hub.log('autoAttach', id, e))));
  }

  async #createTarget(url: string | undefined) {
    const tabId = await this.hub.createTab(this.session, url);
    const ts = await this.attachTab(tabId);
    return { targetId: ts.targetInfo?.targetId };
  }

  /** Attach the debugger (idempotent) and tell Playwright about the tab. */
  attachTab(tabId: number): Promise<TabSession> {
    const existing = this.#tabs.get(tabId);
    if (existing) return Promise.resolve(existing);
    let p = this.#attaching.get(tabId);
    if (!p) {
      p = this.#doAttach(tabId).finally(() => this.#attaching.delete(tabId));
      this.#attaching.set(tabId, p);
    }
    return p;
  }

  async #doAttach(tabId: number): Promise<TabSession> {
    const att = await this.hub.ext.call('attachTab', { tabId });
    if (DEBUG) this.hub.log(`attachTab[${this.session.name}]`, tabId, att);
    const res = await this.hub.ext.call('cdp', { tabId, method: 'Target.getTargetInfo', params: {} });
    const targetInfo = res?.targetInfo;
    // A popup that Playwright sees late (after its first navigation) would wait forever for its
    // opener's "initial navigation". Hide the opener. Playwright then reports it as a plain new page.
    if (targetInfo) {
      delete targetInfo.openerId;
      delete targetInfo.openerFrameId;
      targetInfo.canAccessOpener = false;
    }
    const ts: TabSession = { tabId, sessionId: `pw-tab-${this.#nextSession++}`, targetInfo, children: new Set() };
    this.#tabs.set(tabId, ts);
    this.#lost.delete(tabId);
    this.#send({
      method: 'Target.attachedToTarget',
      params: { sessionId: ts.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false },
    });
    return ts;
  }

  // ----- events from the hub -----

  onTabAdded(tabId: number) {
    if (this.#autoAttach) void this.attachTab(tabId).catch((e) => this.hub.log('attach new tab', tabId, e));
  }

  onTabRemoved(tabId: number) {
    this.#lost.delete(tabId);
    this.#dropTab(tabId);
  }

  onDetached(tabId: number, reason: string) {
    if (reason !== 'target_closed') this.#lost.add(tabId);
    this.#dropTab(tabId);
  }

  /** Attach again to tabs the user detached (Cancel on the infobar). */
  async reattachLost() {
    await Promise.all([...this.#lost].map((id) => this.attachTab(id).catch((e) => this.hub.log('reattach', id, e))));
  }

  #dropTab(tabId: number) {
    const ts = this.#tabs.get(tabId);
    if (!ts) return;
    this.#tabs.delete(tabId);
    this.#send({ method: 'Target.detachedFromTarget', params: { sessionId: ts.sessionId, targetId: ts.targetInfo?.targetId } });
  }

  onCdpEvent(tabId: number, childSession: string | undefined, method: string, params: any) {
    const ts = this.#tabs.get(tabId);
    if (!ts) return;
    const child = params?.sessionId as string | undefined;
    if (method === 'Target.attachedToTarget' && child) ts.children.add(child);
    else if (method === 'Target.detachedFromTarget' && child) ts.children.delete(child);
    const msg = { sessionId: childSession || ts.sessionId, method, params };
    if (ts.hold && !childSession) ts.hold.push(msg);
    else this.#send(msg);
  }
}
