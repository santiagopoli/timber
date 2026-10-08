import './desktop.css';

type DesktopMode = 'view' | 'control';
type DesktopSession = {url: string; protocols: string[]; sessionId: string; expiresAt: string};
type ViewerState = 'disconnected' | 'connecting' | 'reconnecting' | 'paused' | 'viewing' | 'controlling' | 'error';
type Rfb = {
  viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean;
  showDotCursor: boolean; focusOnClick: boolean; qualityLevel: number;
  compressionLevel: number; background: string;
  addEventListener(type: string, callback: EventListener): void;
  disconnect(): void; focus(): void; sendKey(key: number, code: string): void;
};
export interface DesktopViewerOptions {
  element: HTMLElement;
  connect(mode: DesktopMode, replaces?: string): Promise<DesktopSession>;
  renew(sessionId: string): Promise<{expiresAt: string}>;
  release(sessionId: string): Promise<unknown>;
  onState?(state: ViewerState): void;
  onFullscreen?(active: boolean): void;
}

/** Watch intent outlives its transport. Automatic recovery is always view-only. */
export function createDesktopViewer(options: DesktopViewerOptions) {
  const root = options.element;
  root.classList.add('desktop-viewer');
  root.innerHTML = `<div class="desktop-toolbar"><div class="desktop-heading"><strong>Live desktop</strong><span class="desktop-status" role="status" aria-live="polite">Disconnected</span></div><div class="desktop-actions"><button type="button" data-desktop="observe">Watch desktop</button><button type="button" class="quiet" data-desktop="control">Take control</button><button type="button" class="quiet" data-desktop="disconnect" disabled aria-label="Disconnect desktop" title="Disconnect desktop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.5 5.5a8 8 0 1 0 11 0"/></svg></button><button type="button" class="quiet" data-desktop="fullscreen" aria-label="Show desktop fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div></div><p class="desktop-hint">Connect to view the desktop.</p><div class="desktop-screen" tabindex="-1" aria-label="Remote Linux desktop"><div class="desktop-empty">Desktop offline</div></div><div class="desktop-footer"><div class="desktop-keys" hidden><span>Send key</span><button type="button" data-key="Escape">Esc</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Return">Enter</button></div></div>`;
  const dock = document.createElement('div'); dock.id = 'desktop-chat-dock'; root.append(dock);
  let fallbackFullscreen = false;
  const notifyFullscreen = () => {
    const expanded = document.fullscreenElement === root || fallbackFullscreen;
    root.classList.toggle('desktop-fullscreen', expanded);
    fullscreen.setAttribute('aria-label', expanded ? 'Exit desktop fullscreen' : 'Show desktop fullscreen');
    fullscreen.title = expanded ? 'Exit fullscreen' : 'Fullscreen';
    fullscreen.setAttribute('aria-pressed', String(expanded));
    options.onFullscreen?.(expanded);
  };
  async function exitFullscreen() {
    if (document.fullscreenElement === root) await document.exitFullscreen().catch(() => {});
    fallbackFullscreen = false; notifyFullscreen();
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement === root || fallbackFullscreen) {await exitFullscreen(); return;}
    try {if (root.requestFullscreen) {await root.requestFullscreen(); return;}} catch {}
    fallbackFullscreen = true; notifyFullscreen();
  }
  const escapeFullscreen = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && fallbackFullscreen && !event.defaultPrevented && !document.querySelector('[data-screenshot-dialog]')) {event.preventDefault(); void exitFullscreen();}
  };
  const screen = root.querySelector<HTMLElement>('.desktop-screen')!;
  const empty = root.querySelector<HTMLElement>('.desktop-empty')!;
  const status = root.querySelector<HTMLElement>('.desktop-status')!;
  const hint = root.querySelector<HTMLElement>('.desktop-hint')!;
  const observe = root.querySelector<HTMLButtonElement>('[data-desktop="observe"]')!;
  const control = root.querySelector<HTMLButtonElement>('[data-desktop="control"]')!;
  const stop = root.querySelector<HTMLButtonElement>('[data-desktop="disconnect"]')!;
  const fullscreen = root.querySelector<HTMLButtonElement>('[data-desktop="fullscreen"]')!;
  const keys = root.querySelector<HTMLElement>('.desktop-keys')!;
  let active = true;
  let wanted = false;
  let pageActive = true;
  let destroyed = false;
  let generation = 0;
  let rfb: Rfb | undefined;
  let surface: HTMLElement | undefined;
  type Transfer = {session?: DesktopSession; client?: Rfb; surface?: HTMLElement; timer?: ReturnType<typeof setTimeout>};
  let transfer: Transfer | undefined;
  let controlError = '';
  let session: DesktopSession | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  let releasing = Promise.resolve();
  let renewPending = false;
  let retryAttempt = 0;
  let connectedAt = 0;
  let mode: DesktopMode = 'view';
  let state: ViewerState = 'disconnected';
  const setState = (next: ViewerState, message?: string) => {
    state = next;
    root.dataset.state = next;
    status.textContent = message || (transfer ? 'Taking control…' : ({disconnected: 'Disconnected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', paused: 'Paused', viewing: 'Live · watching', controlling: 'Live · you have control', error: 'Connection unavailable'}[next]));
    observe.disabled = Boolean(transfer) || next === 'connecting' || next === 'viewing';
    control.disabled = Boolean(transfer) || next === 'connecting' || next === 'controlling';
    stop.disabled = !wanted;
    keys.hidden = next !== 'controlling';
    root.querySelector<HTMLElement>('.desktop-footer')!.hidden = next !== 'controlling';
    empty.hidden = next === 'viewing' || next === 'controlling';
    empty.textContent = next === 'connecting' || next === 'reconnecting' ? 'Connecting…' : next === 'paused' ? 'Preview paused' : 'Desktop offline';
    hint.textContent = next === 'controlling'
      ? 'You have control. Switch to Watch desktop to release it.'
      : next === 'viewing'
      ? controlError || 'View only'
      : next === 'paused' || next === 'reconnecting' ? 'Watch will resume automatically.' : 'Connect to view the desktop.';
    options.onState?.(next);
  };
  const available = () => active && pageActive && !document.hidden && navigator.onLine;
  const release = (current?: DesktopSession) => {
    if (current) releasing = Promise.all([releasing, options.release(current.sessionId).catch(() => {})]).then(() => {});
    return releasing;
  };
  function cancelTransfer() {
    const pending = transfer;
    transfer = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.client?.disconnect();
    pending.surface?.remove();
    void release(pending.session);
  }
  const clearConnection = () => {
    cancelTransfer();
    controlError = '';
    generation++;
    if (heartbeat) clearTimeout(heartbeat);
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    if (retryTimer) clearTimeout(retryTimer);
    if (backgroundTimer) clearTimeout(backgroundTimer);
    heartbeat = undefined;
    handshakeTimeout = undefined;
    retryTimer = undefined;
    backgroundTimer = undefined;
    const previous = rfb;
    rfb = undefined;
    previous?.disconnect();
    surface?.remove(); surface = undefined;
    const released = release(session);
    session = undefined;
    renewPending = false;
    connectedAt = 0;
    return released;
  };
  function disconnect() {
    if (document.fullscreenElement === root || fallbackFullscreen) void exitFullscreen();
    wanted = false;
    retryAttempt = 0;
    const released = clearConnection();
    setState('disconnected');
    return released;
  }
  function pause() {
    void clearConnection();
    mode = 'view';
    if (wanted) setState('paused', navigator.onLine ? 'Paused' : 'Waiting for connection…');
  }
  function retry() {
    if (!wanted || destroyed) return;
    if (!available()) {setState('paused', navigator.onLine ? 'Paused' : 'Waiting for connection…'); return;}
    setState('reconnecting');
    const delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 4), 10_000);
    retryTimer = setTimeout(() => {retryTimer = undefined; void start('view');}, delay);
  }
  function recover(error?: unknown) {
    const failure = error as {status?: number; code?: string; message?: string} | undefined;
    if (connectedAt && Date.now() - connectedAt > 15_000) retryAttempt = 0;
    void clearConnection();
    mode = 'view';
    // A revoked account/bot or unsupported computer needs an explicit correction.
    // Desktop lease expiry only replaces this viewer's grant, never the login.
    if (failure?.status && [400, 401, 403, 404, 409].includes(failure.status) && failure.code !== 'desktop_session_expired') {
      wanted = false;
      setState('error', failure.message || 'Desktop access is unavailable.');
    } else retry();
  }
  function scheduleRenew(current: number, delay = 20_000) {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {heartbeat = undefined; void renew(current);}, delay);
  }
  async function renew(current: number) {
    if (current !== generation || !session || renewPending) return;
    if (Date.parse(session.expiresAt) <= Date.now()) {recover(); return;}
    renewPending = true;
    try {
      const result = await options.renew(session.sessionId);
      if (current !== generation || !session) return;
      if (!Number.isFinite(Date.parse(result.expiresAt))) throw new Error('Desktop access could not be renewed.');
      session.expiresAt = result.expiresAt;
      if (connectedAt) setState(mode === 'control' ? 'controlling' : 'viewing');
      scheduleRenew(current);
    } catch (error) {
      if (current !== generation || !session) return;
      const failure = error as {status?: number};
      if (!failure.status && navigator.onLine && Date.parse(session.expiresAt) - Date.now() > 5000) {
        // A lost heartbeat does not invalidate a still-live framebuffer/lease.
        scheduleRenew(current, 2000);
      } else if (failure.status && failure.status >= 500 && Date.parse(session.expiresAt) - Date.now() > 5000) {
        scheduleRenew(current, 2000);
      } else recover(error);
    } finally {if (current === generation) renewPending = false;}
  }
  async function connect(nextMode: DesktopMode = 'view') {
    if (destroyed || !active || !pageActive || document.hidden) return;
    wanted = true;
    retryAttempt = 0;
    if (nextMode === 'control' && mode === 'view' && rfb && session && connectedAt) await takeControl();
    else await start(nextMode);
  }
  async function createClient(connection: DesktopSession, host: HTMLElement, nextMode: DesktopMode, valid: () => boolean): Promise<Rfb> {
    // Credentials are one-use subprotocols, never a browser/history URL.
    const target = new URL(connection.url, window.location.href);
    if (target.protocol === 'https:') target.protocol = 'wss:';
    if (target.protocol === 'http:') target.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(target.protocol) || target.search || target.username || target.password) throw new Error('The desktop endpoint is invalid.');
    const {default: RFB} = await import('@novnc/novnc');
    if (!valid()) throw new DOMException('Desktop session changed.', 'AbortError');
    const client = new RFB(host, target.href, {shared: true, wsProtocols: connection.protocols}) as Rfb;
    client.viewOnly = nextMode === 'view'; client.focusOnClick = nextMode === 'control';
    client.scaleViewport = true; client.resizeSession = false; client.showDotCursor = false;
    client.qualityLevel = 7; client.compressionLevel = 2; client.background = '#111111';
    return client;
  }
  function track(client: Rfb, nextMode: DesktopMode, current: number, connected = false) {
    const ready = () => {
      if (current !== generation) return;
      clearTimeout(handshakeTimeout); handshakeTimeout = undefined;
      connectedAt = Date.now(); setState(nextMode === 'control' ? 'controlling' : 'viewing');
    };
    client.addEventListener('connect', ready);
    for (const event of ['disconnect', 'securityfailure']) client.addEventListener(event, () => {if (current === generation) recover();});
    if (connected) ready();
    else handshakeTimeout = setTimeout(() => {if (current === generation) recover();}, 30_000);
    scheduleRenew(current);
  }
  async function takeControl() {
    if (transfer || !session) return;
    const previous = session, pending: Transfer = {};
    transfer = pending; controlError = ''; setState('viewing');
    const valid = () => transfer === pending && available() && wanted && !destroyed;
    const failed = (error?: unknown) => {
      if (transfer !== pending) return;
      cancelTransfer();
      controlError = error instanceof Error ? error.message : 'Could not take control. You are still watching.';
      setState('viewing');
    };
    try {
      const connection = await options.connect('control', previous.sessionId);
      if (!valid()) {void release(connection); return;}
      pending.session = connection;
      const host = document.createElement('div');
      host.className = 'desktop-surface desktop-transfer'; screen.append(host); pending.surface = host;
      // The existing view stays live until the replacement has negotiated RFB.
      const client = await createClient(connection, host, 'view', valid); pending.client = client;
      client.addEventListener('connect', () => {
        if (!valid()) {if (transfer === pending) cancelTransfer(); return;}
        transfer = undefined; clearTimeout(pending.timer);
        void clearConnection();
        session = connection; rfb = client; surface = host; mode = 'control';
        client.viewOnly = false; client.focusOnClick = true;
        host.classList.remove('desktop-transfer');
        track(client, 'control', generation, true);
      });
      for (const event of ['disconnect', 'securityfailure']) client.addEventListener(event, () => failed());
      pending.timer = setTimeout(() => failed(new Error('Control did not connect. You are still watching.')), 30_000);
    } catch (error) {failed(error);}
  }
  async function start(nextMode: DesktopMode) {
    if (destroyed || !wanted || !available()) {if (wanted) setState('paused', 'Waiting for connection…'); return;}
    const released = clearConnection();
    const current = generation;
    mode = nextMode;
    setState('connecting', 'Starting secure desktop…');
    try {
      await released;
      if (current !== generation || destroyed || !available()) return;
      const connection = await options.connect(nextMode);
      if (current !== generation || destroyed || !available()) { void release(connection); return; }
      session = connection;
      const host = document.createElement('div'); host.className = 'desktop-surface'; screen.append(host); surface = host;
      const client = await createClient(connection, host, nextMode, () => current === generation && !destroyed && available());
      rfb = client; track(client, nextMode, current);
    } catch (error) {
      if (current !== generation) return;
      recover(error);
    }
  }
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || target.disabled) return;
    switch (target.dataset.desktop) {
      case 'observe': void connect('view'); break;
      case 'control': void connect('control'); break;
      case 'disconnect': disconnect(); break;
      case 'fullscreen':
        void toggleFullscreen();
        break;
    }
    if (target.dataset.key && state === 'controlling' && mode === 'control') {
      const key = ({Escape: 0xff1b, Tab: 0xff09, Return: 0xff0d} as Record<string, number>)[target.dataset.key];
      if (key) { rfb?.sendKey(key, target.dataset.key); rfb?.focus(); }
    }
  };
  function reconcile() {
    if (!wanted || destroyed) return;
    if (!available()) {
      // A hidden pending controller must be released even while Watch remains
      // in its short background grace period.
      if (transfer) {cancelTransfer(); setState('viewing');}
      // Brief tab/panel switches keep Watch's existing socket. Background work
      // stops after a grace period; control is released immediately.
      if (!pageActive || !navigator.onLine || mode === 'control' || !connectedAt) pause();
      else if (!backgroundTimer) backgroundTimer = setTimeout(pause, 30_000);
      return;
    }
    if (backgroundTimer) clearTimeout(backgroundTimer);
    backgroundTimer = undefined;
    if (session && rfb) {void renew(generation); return;}
    if (state === 'connecting') return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    void start('view');
  }
  const onLeave = () => {pageActive = false; if (wanted) pause();};
  const onReturn = () => {pageActive = true; reconcile();};
  root.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', reconcile);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('online', reconcile);
  window.addEventListener('offline', reconcile);
  document.addEventListener('fullscreenchange', notifyFullscreen);
  document.addEventListener('keydown', escapeFullscreen);
  return {
    connect, disconnect, exitFullscreen,
    setActive(value: boolean) {if (active === value) return; active = value; reconcile();},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      wanted = false;
      clearConnection();
      void exitFullscreen();
      document.removeEventListener('fullscreenchange', notifyFullscreen);
      document.removeEventListener('keydown', escapeFullscreen);
      root.removeEventListener('click', onClick);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onReturn);
      window.removeEventListener('online', reconcile);
      window.removeEventListener('offline', reconcile);
      root.replaceChildren();
    },
  };
}
