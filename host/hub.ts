import { Kernel } from './kernel-handle.ts';
import type { ExtensionChannel } from './ext.ts';
import type { Logger } from './log.ts';
import type { RelayConn } from './relay.ts';

export type Session = {
  name: string;
  tabs: Map<number, { claimed: boolean }>;
  conns: Set<RelayConn>;
  kernel?: Kernel;
  queue: Promise<unknown>;
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
      case 'tabRemoved':
        this.#removeTab(e.tabId);
        break;
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
    const k = new Kernel(s.name, `${this.relayBase}/${s.name}`, this.log, () => {
      if (s.kernel === k) s.kernel = undefined;
    });
    s.kernel = k;
    const r = await k.call('init', { timeoutMs }, timeoutMs);
    if (!r.ok) {
      k.kill();
      s.kernel = undefined;
      throw new Error(r.error);
    }
    return k;
  }

  runJs(name: string, code: string, timeoutMs: number) {
    const s = this.session(name);
    return this.#serial(s, async () => {
      const k = await this.#kernel(s, timeoutMs);
      await Promise.all([...s.conns].map((c) => c.reattachLost()));
      return (await k.call('js', { code }, timeoutMs)) as { ok: boolean; output?: string; error?: string };
    });
  }

  claim(name: string, tabId: number, timeoutMs: number) {
    const s = this.session(name);
    return this.#serial(s, async () => {
      const k = await this.#kernel(s, timeoutMs);
      const tab = await this.ext.call('claimTab', { session: name, tabId });
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
