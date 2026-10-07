import './desktop.css';

type DesktopMode = 'view' | 'control';
type DesktopSession = {url: string; protocols: string[]; sessionId: string; expiresAt: string};
type ViewerState = 'disconnected' | 'connecting' | 'viewing' | 'controlling' | 'error';
type Rfb = {
  viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean;
  showDotCursor: boolean; focusOnClick: boolean; qualityLevel: number;
  compressionLevel: number; background: string;
  addEventListener(type: string, callback: EventListener): void;
  disconnect(): void; focus(): void; sendKey(key: number, code: string): void;
};
export interface DesktopViewerOptions {
  element: HTMLElement;
  connect(mode: DesktopMode): Promise<DesktopSession>;
  renew(sessionId: string): Promise<unknown>;
  release(sessionId: string): Promise<unknown>;
  onState?(state: ViewerState): void;
}

/** Owns one live session. Navigation invalidates pending async connects as well. */
export function createDesktopViewer(options: DesktopViewerOptions) {
  const root = options.element;
  root.classList.add('desktop-viewer');
  root.innerHTML = `<div class="desktop-toolbar"><div class="desktop-heading"><strong>Live desktop</strong><span class="desktop-status" role="status" aria-live="polite">Disconnected</span></div><div class="desktop-actions"><button type="button" data-desktop="observe">Watch desktop</button><button type="button" class="quiet" data-desktop="control">Take control</button><button type="button" class="quiet" data-desktop="disconnect" disabled aria-label="Disconnect desktop" title="Disconnect desktop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.5 5.5a8 8 0 1 0 11 0"/></svg></button><button type="button" class="quiet" data-desktop="fullscreen" aria-label="Show desktop fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div></div><p class="desktop-hint">Connect to view the desktop.</p><div class="desktop-screen" tabindex="-1" aria-label="Remote Linux desktop"><div class="desktop-empty">Desktop offline</div></div><div class="desktop-footer"><div class="desktop-keys" hidden><span>Send key</span><button type="button" data-key="Escape">Esc</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Return">Enter</button></div></div>`;
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
  let destroyed = false;
  let generation = 0;
  let rfb: Rfb | undefined;
  let session: DesktopSession | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
  let renewPending = false;
  let mode: DesktopMode = 'view';
  let state: ViewerState = 'disconnected';
  const setState = (next: ViewerState, message?: string) => {
    state = next;
    root.dataset.state = next;
    status.textContent = message || ({disconnected: 'Disconnected', connecting: 'Connecting…', viewing: 'Live · watching', controlling: 'Live · you have control', error: 'Connection unavailable'}[next]);
    observe.disabled = next === 'connecting' || next === 'viewing';
    control.disabled = next === 'connecting' || next === 'controlling';
    stop.disabled = next === 'disconnected' || next === 'error';
    keys.hidden = next !== 'controlling';
    root.querySelector<HTMLElement>('.desktop-footer')!.hidden = next !== 'controlling';
    empty.hidden = next === 'viewing' || next === 'controlling';
    hint.textContent = next === 'controlling'
      ? 'You have control. Switch to Watch desktop to release it.'
      : next === 'viewing'
      ? 'View only'
      : 'Connect to view the desktop.';
    options.onState?.(next);
  };
  const release = (current?: DesktopSession) => current
    ? options.release(current.sessionId).catch(() => {}) : Promise.resolve();
  const clearConnection = () => {
    generation++;
    if (heartbeat) clearInterval(heartbeat);
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    heartbeat = undefined;
    handshakeTimeout = undefined;
    const previous = rfb;
    rfb = undefined;
    previous?.disconnect();
    const released = release(session);
    session = undefined;
    renewPending = false;
    return released;
  };
  function disconnect() {
    const released = clearConnection();
    setState('disconnected');
    return released;
  }
  async function connect(nextMode: DesktopMode = 'view') {
    if (destroyed || !active || document.hidden) return;
    const released = clearConnection();
    const current = generation;
    mode = nextMode;
    setState('connecting', 'Starting secure desktop…');
    try {
      await released;
      if (current !== generation || destroyed || !active || document.hidden) return;
      const connection = await options.connect(nextMode);
      if (current !== generation || destroyed || !active || document.hidden) { release(connection); return; }
      session = connection;
      // Credentials are one-use subprotocols, never a browser/history URL.
      const target = new URL(connection.url, window.location.href);
      if (target.protocol === 'https:') target.protocol = 'wss:';
      if (target.protocol === 'http:') target.protocol = 'ws:';
      if (!['ws:', 'wss:'].includes(target.protocol) || target.search || target.username || target.password) throw new Error('The desktop endpoint is invalid.');
      const {default: RFB} = await import('@novnc/novnc');
      if (current !== generation || destroyed || !active || document.hidden) return;
      const client = new RFB(screen, target.href, {shared: true, wsProtocols: connection.protocols}) as Rfb;
      rfb = client;
      client.viewOnly = nextMode === 'view';
      client.focusOnClick = nextMode === 'control';
      client.scaleViewport = true;
      client.resizeSession = false;
      client.showDotCursor = false;
      client.qualityLevel = 7;
      client.compressionLevel = 2;
      client.background = '#111111';
      client.addEventListener('connect', () => {
        if (current !== generation) return;
        if (handshakeTimeout) clearTimeout(handshakeTimeout);
        handshakeTimeout = undefined;
        setState(nextMode === 'control' ? 'controlling' : 'viewing');
      });
      client.addEventListener('disconnect', () => {
        if (current !== generation) return;
        clearConnection();
        setState('error', 'Desktop disconnected. Connect again to resume.');
      });
      client.addEventListener('securityfailure', () => {
        if (current !== generation) return;
        clearConnection();
        setState('error', 'Desktop authorization expired. Connect again.');
      });
      handshakeTimeout = setTimeout(() => {
        if (current === generation) { clearConnection(); setState('error', 'Desktop connection timed out. Connect again.'); }
      }, 30_000);
      heartbeat = setInterval(() => {
        if (current !== generation || !session || renewPending) return;
        if (!active || document.hidden) { disconnect(); return; }
        renewPending = true;
        void options.renew(connection.sessionId).catch(() => {
          if (current === generation) { clearConnection(); setState('error', 'Desktop session expired. Connect again.'); }
        }).finally(() => { if (current === generation) renewPending = false; });
      }, 20_000);
    } catch (error) {
      if (current !== generation) return;
      clearConnection();
      setState('error', error instanceof Error ? error.message : 'Could not connect to the desktop.');
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
        if (document.fullscreenElement === root) void document.exitFullscreen();
        else void root.requestFullscreen?.().catch(() => {});
        break;
    }
    if (target.dataset.key && state === 'controlling' && mode === 'control') {
      const key = ({Escape: 0xff1b, Tab: 0xff09, Return: 0xff0d} as Record<string, number>)[target.dataset.key];
      if (key) { rfb?.sendKey(key, target.dataset.key); rfb?.focus(); }
    }
  };
  const onHidden = () => { if (document.hidden) disconnect(); };
  const onLeave = () => disconnect();
  root.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onLeave);
  fullscreen.hidden = !root.requestFullscreen;
  return {
    connect, disconnect,
    setActive(value: boolean) { active = value; if (!value) disconnect(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearConnection();
      root.removeEventListener('click', onClick);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onLeave);
      root.replaceChildren();
    },
  };
}
