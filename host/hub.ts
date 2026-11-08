import { Kernel } from './kernel-handle.ts';
import type { Event } from './server.ts';
import type { ExtensionChannel } from './ext.ts';
import type { Logger } from './log.ts';
import type { RelayConn } from './relay.ts';

type Handoff = {
  tabId: number;
  done: boolean;
  timer?: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
};

export type Session = {
  name: string;
  tabs: Map<number, { claimed: boolean }>;
  conns: Set<RelayConn>;
  kernel?: Kernel;
  queue: Promise<unknown>;
  /** Set when the user took a claimed tab back. The next `js` call reports it once. */
  tookBack?: number;
  /** Sends a progress event to the CLI of the running call. */
  emit?: (e: Event) => void;
  handoff?: Handoff;
};

/** Host state: sessions, their tabs, relay connections, and kernels. */
export class Hub {
  sessions = new Map<string, Session>();
  tabToSession = new Map<number, string>();
  chromeVersion = '0.0.0.0';
  userAgent = 'buu';
  relayBase = '';

  readonly ext: ExtensionChannel;
  readonly log: Logger;

  constructor(ext: ExtensionChannel, log: Logger) {
    this.ext = ext;
    this.log = log;
    ext.on('event', (e) => this.#onEvent(e));
  }

  session(name: string): Session {
    let s = this.sessions.get(name);
    if (!s) {
      s = { name, tabs: new Map(), conns: new Set(), queue: Promise.resolve() };
      this.sessions.set(name, s);
    }
    return s;
  }

  /** Rebuild sessions from the extension after a host restart. */
  restore(sessions: Record<string, { agent: number[]; claimed: number[] }>) {
    for (const [name, s] of Object.entries(sessions)) {
      for (const id of s.agent) this.#addTab(this.session(name), id, false);
      for (const id of s.claimed) this.#addTab(this.session(name), id, true);
    }
  }

  #addTab(s: Session, tabId: number, claimed: boolean) {
    s.tabs.set(tabId, { claimed });
    this.tabToSession.set(tabId, s.name);
    for (const c of s.conns) c.onTabAdded(tabId);
  }

  #removeTab(tabId: number) {
    const name = this.tabToSession.get(tabId);
    if (!name) return;
    this.tabToSession.delete(tabId);
    const s = this.sessions.get(name);
    s?.tabs.delete(tabId);
    for (const c of s?.conns ?? []) c.onTabRemoved(tabId);
  }

  #onEvent(e: any) {
    const s = e.tabId !== undefined ? this.sessions.get(this.tabToSession.get(e.tabId) ?? '') : undefined;
    switch (e.event) {
      case 'cdp':
        for (const c of s?.conns ?? []) c.onCdpEvent(e.tabId, e.sessionId, e.method, e.params);
        break;
      case 'detached':
        for (const c of s?.conns ?? []) c.onDetached(e.tabId, e.reason);
        break;
      case 'log':
        this.log('ext:', e.message);
        break;
      case 'tabRemoved':
        this.#removeTab(e.tabId);
        break;
      case 'handoffDone':
      case 'handoffAborted': {
        const owner = this.sessions.get(this.tabToSession.get(e.tabId) ?? '');
        if (owner && owner.handoff?.tabId === e.tabId) this.#endHandoff(owner, e.event === 'handoffDone' ? undefined : new Error(`handoff stopped: ${e.reason}`));
        break;
      }
      case 'takenBack': {
        // The user took a claimed tab back. Stop the running call first, then drop the tab.
        const t = this.sessions.get(e.session);
        if (t) {
          t.tookBack = e.tabId;
          t.kernel?.kill();
          t.kernel = undefined;
        }
        this.#removeTab(e.tabId);
        break;
      }
      case 'tabCreated':
        this.#addTab(this.session(e.session), e.tabId, false);
        break;
    }
  }

  // ----- tab operations used by the relay -----

  async createTab(s: Session, url?: string): Promise<number> {
    const { tabId } = await this.ext.call('createTab', { session: s.name, url });
    this.#addTab(s, tabId, false);
    return tabId;
  }

  async closeTab(s: Session, tabId: number): Promise<void> {
    await this.ext.call('closeTab', { tabId });
    this.#removeTab(tabId);
  }

  // ----- commands from the CLI -----

  /** Run one task at a time per session. */
  #serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const p = s.queue.then(fn);
    s.queue = p.catch(() => {});
    return p;
  }

  async #kernel(s: Session, timeoutMs: number): Promise<Kernel> {
    if (s.kernel && !s.kernel.dead) return s.kernel;
    const k = new Kernel(
      s.name,
      `${this.relayBase}/${s.name}`,
      this.log,
      () => {
        if (s.kernel === k) s.kernel = undefined;
        this.#endHandoff(s, new Error('handoff stopped: the kernel exited'));
      },
      (op, payload) => this.#kernelRequest(s, op, payload),
    );
    s.kernel = k;
    const r = await k.call('init', { timeoutMs }, timeoutMs);
    if (!r.ok) {
      k.kill();
      s.kernel = undefined;
      throw new Error(r.error);
    }
    return k;
  }

  // ----- handoff: the user does a step in a tab -----

  async #kernelRequest(s: Session, op: string, m: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'handoffBegin': {
        if (s.handoff && !s.handoff.done) throw new Error('handoff: another handoff waits in this session');
        // Find the tab: the kernel set a marker in the page of the current tab.
        let tabId: number | undefined;
        for (const id of s.tabs.keys()) {
          const r = await this.ext
            .call('cdp', { tabId: id, method: 'Runtime.evaluate', params: { expression: 'window.__buuProbe', returnByValue: true } })
            .catch(() => null);
          if (r?.result?.value === m.probe) {
            tabId = id;
            break;
          }
        }
        if (tabId === undefined) throw new Error('handoff: the current page is not a tab of this session');
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        promise.catch(() => {}); // the kernel reads the result later
        const h: Handoff = { tabId, done: false, promise, resolve, reject };
        s.handoff = h;
        try {
          await this.ext.call('handoffBegin', { session: s.name, tabId, message: String(m.message) });
        } catch (e) {
          s.handoff = undefined;
          throw e;
        }
        s.kernel?.pauseDeadline();
        s.emit?.({ event: 'handoff', tabId, message: String(m.message) });
        h.timer = setTimeout(() => this.#endHandoff(s, new Error('handoff timed out')), Number(m.timeoutMs));
        return {};
      }
      case 'handoffWait': {
        const h = s.handoff;
        if (!h) throw new Error('handoff: none is waiting');
        try {
          await h.promise;
        } finally {
          if (s.handoff === h) s.handoff = undefined;
        }
        return {};
      }
      case 'handoffCancel':
        this.#endHandoff(s, new Error('handoff cancelled'));
        return {};
    }
    throw new Error(`unknown kernel request ${op}`);
  }

  /** End the handoff of a session. No error = the user continued. */
  #endHandoff(s: Session, err?: Error) {
    const h = s.handoff;
    if (!h || h.done) return;
    h.done = true;
    clearTimeout(h.timer);
    s.kernel?.resumeDeadline();
    s.emit?.({ event: 'handoffEnd' });
    void this.ext.call('handoffEnd', { tabId: h.tabId }).catch(() => {});
    if (err) h.reject(err);
    else h.resolve();
  }

  /** The CLI of a running call went away. Stop its handoff. */
  abortCall(name: string) {
    const s = this.sessions.get(name);
    if (s) this.#endHandoff(s, new Error('handoff stopped: the buu command ended'));
  }

  runJs(name: string, code: string, timeoutMs: number, emit?: (e: Event) => void) {
    const s = this.session(name);
    return this.#serial(s, async () => {
      if (s.tookBack !== undefined) {
        const id = s.tookBack;
        s.tookBack = undefined;
        throw new Error(`the user took tab ${id} back. buu detached it. Ask the user to lend a tab again.`);
      }
      const k = await this.#kernel(s, timeoutMs);
      await Promise.all([...s.conns].map((c) => c.reattachLost()));
      await this.ext.call('setRunning', { session: name, running: true }).catch(() => {});
      s.emit = emit;
      try {
        return (await k.call('js', { code }, timeoutMs)) as { ok: boolean; output?: string; error?: string };
      } catch (e) {
        if (s.tookBack !== undefined) throw new Error(`the user took tab ${s.tookBack} back. The running call stopped.`);
        throw e;
      } finally {
        s.emit = undefined;
        await this.ext.call('setRunning', { session: name, running: false }).catch(() => {});
      }
    });
  }

  claim(name: string, tabId: number, timeoutMs: number) {
    const s = this.session(name);
    return this.#serial(s, async () => {
      const k = await this.#kernel(s, timeoutMs);
      const tab = await this.ext.call('claimTab', { session: name, tabId });
      s.tookBack = undefined;
      this.#addTab(s, tabId, true);
      await Promise.all([...s.conns].map((c) => c.attachTab(tabId)));
      const r = await k.call('claim', { url: tab.url }, timeoutMs);
      if (!r.ok) throw new Error(r.error);
      return tab as { tabId: number; url: string; title: string };
    });
  }

  end(name: string, keep: number[]) {
    const s = this.session(name);
    return this.#serial(s, async () => {
      s.kernel?.kill();
      s.kernel = undefined;
      for (const c of [...s.conns]) c.close();
      const result = await this.ext.call('endSession', { session: name, keep });
      for (const id of [...s.tabs.keys()]) this.tabToSession.delete(id);
      this.sessions.delete(name);
      return result as { closed: number[]; detached: number[]; kept: number[] };
    });
  }

  async status() {
    const { sessions } = await this.ext.call('getState');
    const names = new Set([...Object.keys(sessions), ...this.sessions.keys()]);
    return [...names].map((name) => ({
      name,
      kernel: !!this.sessions.get(name)?.kernel && !this.sessions.get(name)!.kernel!.dead,
      tabs: (sessions[name]?.tabs ?? []) as unknown[],
    }));
  }

  listUserTabs() {
    return this.ext.call('listUserTabs');
  }

  shutdown() {
    for (const s of this.sessions.values()) {
      s.kernel?.kill();
      for (const c of s.conns) c.close();
    }
  }
}
