import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './shell.css';

export type ShellSession = {url: string; protocols: string[]; sessionId: string; expiresAt: string};
type ShellState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface ShellViewerOptions {
  element: HTMLElement;
  connect(): Promise<ShellSession>;
  renew(sessionId: string): Promise<{expiresAt: string}>;
  release(sessionId: string): Promise<unknown>;
}

/** Explicit connection intent only. No input replay, transcript storage or automatic reconnect.
 * All frames use the documented timber-shell.v1 JSON protocol. Output is acked
 * only after xterm consumes it, bounding server-side unrendered output.
 */
export function createShellViewer(options: ShellViewerOptions) {
  const root = options.element;
  root.classList.add('shell-viewer');
  root.innerHTML = `<div class="shell-toolbar"><strong>Shell</strong><span class="shell-status" role="status" aria-live="polite">Disconnected</span><button type="button" data-shell="connect">Connect</button><button type="button" class="quiet" data-shell="disconnect" disabled>Disconnect</button></div><p class="shell-hint" id="shell-help">Connect starts an interactive shell in /workspace. Commands run directly as you.</p><div class="shell-terminal" aria-label="Interactive Linux shell" aria-describedby="shell-help"></div><div class="shell-keys" role="group" aria-label="Shell keyboard"><button type="button" class="quiet" data-shell-key="keyboard">Keyboard</button><button type="button" class="quiet" data-shell-key="ctrl-c">Ctrl-C</button><button type="button" class="quiet" data-shell-key="esc">Esc</button><button type="button" class="quiet" data-shell-key="tab">Tab</button><button type="button" class="quiet" data-shell-key="up" aria-label="Previous command">↑</button><button type="button" class="quiet" data-shell-key="down" aria-label="Next command">↓</button><button type="button" class="quiet" data-shell-key="enter">Enter</button></div>`;
  const surface = root.querySelector<HTMLElement>('.shell-terminal')!;
  const status = root.querySelector<HTMLElement>('.shell-status')!;
  const hint = root.querySelector<HTMLElement>('.shell-hint')!;
  const connectButton = root.querySelector<HTMLButtonElement>('[data-shell="connect"]')!;
  const stopButton = root.querySelector<HTMLButtonElement>('[data-shell="disconnect"]')!;
  let active = false, destroyed = false, generation = 0;
  let state: ShellState = 'disconnected';
  let term: Terminal | undefined, fit: FitAddon | undefined;
  let socket: WebSocket | undefined, session: ShellSession | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined, handshake: ReturnType<typeof setTimeout> | undefined;
  let frame = 0, queuedBytes = 0, lastSequence = 0, ended = false;
  const maxQueuedBytes = 256 * 1024;
  const encoder = new TextEncoder();
  // xterm emits renderer rules through <style> nodes. Convert those trusted,
  // library-owned rules to constructed stylesheets so the console keeps its
  // strict style-src; terminal output is never interpreted as CSS.
  const rendererSheets = new Set<CSSStyleSheet>();
  const nativeCreateElement = document.createElement.bind(document);
  const rendererCreateElement = (tag: string, options?: ElementCreationOptions) => {
    if (tag.toLowerCase() !== 'style') return nativeCreateElement(tag, options);
    const placeholder = nativeCreateElement('span'); placeholder.hidden = true;
    const sheet = new CSSStyleSheet(); rendererSheets.add(sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(placeholder, 'textContent', {set(value: string) {sheet.replaceSync(value || '');}, get() {return '';}});
    return placeholder;
  };
  const setState = (next: ShellState, message?: string) => {
    state = next; root.dataset.state = next;
    status.textContent = {disconnected:'Disconnected', connecting:'Connecting…', connected:'Connected', error:'Connection error'}[next];
    hint.textContent = message || (next === 'connected' ? 'Interactive shell · /workspace. Closing this view disconnects the session.' : 'Connect starts an interactive shell in /workspace. Commands run directly as you.');
    connectButton.disabled = !active || next === 'connecting' || next === 'connected';
    stopButton.disabled = next !== 'connecting' && next !== 'connected';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-shell-key]')) button.disabled = next !== 'connected';
    if (term) term.options.disableStdin = next !== 'connected';
  };
  const release = (ticket?: ShellSession) => ticket ? options.release(ticket.sessionId).then(() => {}, () => {}) : Promise.resolve();
  function clearConnection(clearTerminal = false) {
    generation++; clearTimeout(heartbeat); clearTimeout(handshake); heartbeat = handshake = undefined;
    const currentSocket = socket; socket = undefined;
    if (currentSocket) {currentSocket.onopen = currentSocket.onmessage = currentSocket.onerror = currentSocket.onclose = null; currentSocket.close();}
    const ticket = session; session = undefined;
    const version = generation;
    const released = ticket ? options.release(ticket.sessionId).catch(() => {
      if (generation === version && !destroyed) hint.textContent = 'Disconnected locally, but server cleanup is not confirmed. New shells and checkpoints remain blocked until cleanup succeeds.';
    }) : Promise.resolve();
    queuedBytes = 0; lastSequence = 0; ended = false;
    if (clearTerminal) {term?.dispose(); document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => !rendererSheets.has(sheet)); rendererSheets.clear(); term = undefined; fit = undefined; surface.replaceChildren();}
    return released;
  }
  function disconnect() {const released=clearConnection(true); setState('disconnected'); return released;}
  const available = () => active && !destroyed && !document.hidden && navigator.onLine;
  function fail(message: string) {clearConnection(true); setState('error', message);}
  function send(message: {type:'input';data:string}|{type:'resize';cols:number;rows:number}|{type:'ack';seq:number}) {
    if (state !== 'connected' || socket?.readyState !== WebSocket.OPEN || !available()) return;
    const wire = JSON.stringify(message);
    if (encoder.encode(wire).byteLength > 16 * 1024) {
      if (message.type === 'input') setState('connected', 'That paste is too large for one terminal input. Paste a smaller section; nothing was sent.');
      else fail('Shell control message exceeded the transport limit. Connect again.');
      return;
    }
    if (socket.bufferedAmount > maxQueuedBytes) {fail('Input transport is congested. Reconnect explicitly; input is not replayed.'); return;}
    socket.send(wire);
  }
  function resize() {
    if (!active || !term || !fit || surface.clientWidth < 2 || surface.clientHeight < 2) return;
    fit.fit();
    if (state === 'connected' && socket?.readyState === WebSocket.OPEN) send({type:'resize', cols:term.cols, rows:term.rows});
  }
  function layout() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!active || destroyed) return;
      const viewport = window.visualViewport;
      const bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
      const availableHeight = Math.max(160, bottom - root.getBoundingClientRect().top);
      root.style.setProperty('--shell-available-height', `${availableHeight}px`);
      root.dataset.viewportConstrained = String(availableHeight < 260);
      resize();
    });
  }
  const valid = (version: number) => generation === version && available();
  function scheduleRenew(version: number) {
    if (!session || !valid(version)) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {fail('Shell session expired. Connect again for a fresh session.'); return;}
    heartbeat = setTimeout(async () => {
      const current = session;
      if (!current || !valid(version)) return;
      try {
        const renewed = await options.renew(current.sessionId);
        if (!valid(version) || session !== current) return;
        const expiresAt = Date.parse(renewed.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('expired');
        current.expiresAt = renewed.expiresAt; scheduleRenew(version);
      } catch {if (valid(version)) fail('Shell lease could not be renewed. Connect again for a fresh session.');}
    }, Math.max(100, Math.min(30000, remaining * 0.5)));
  }
  async function connect() {
    if (!available() || state === 'connecting' || state === 'connected') return;
    await clearConnection(true); const version = generation; setState('connecting');
    try {
      const ticket = await options.connect();
      if (!valid(version)) {release(ticket); return;}
      session = ticket;
      const url = new URL(ticket.url, location.origin);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.host !== location.host || url.username || url.password || url.search || url.hash || (location.protocol === 'https:' && url.protocol !== 'wss:') || !ticket.sessionId || !Array.isArray(ticket.protocols) || !ticket.protocols.length || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) throw new Error('invalid session');
      term = new Terminal({scrollback:1000, fontSize:13, cursorBlink:true, screenReaderMode:true, disableStdin:true, convertEol:false, allowProposedApi:false});
      fit = new FitAddon(); term.loadAddon(fit);
      const createElementDescriptor = Object.getOwnPropertyDescriptor(document, 'createElement');
      Object.defineProperty(document, 'createElement', {configurable:true, value:rendererCreateElement});
      try {term.open(surface);} finally {
        if (createElementDescriptor) Object.defineProperty(document, 'createElement', createElementDescriptor);
        else Reflect.deleteProperty(document, 'createElement');
      }
      term.textarea?.setAttribute('aria-label', 'Shell input');
      term.textarea?.setAttribute('autocapitalize', 'off');
      term.textarea?.setAttribute('autocomplete', 'off');
      term.textarea?.setAttribute('spellcheck', 'false');
      term.onData(data => send({type:'input', data})); term.onBinary(data => send({type:'input', data}));
      const client = new WebSocket(url.href, ticket.protocols); socket = client; client.binaryType = 'arraybuffer';
      handshake = setTimeout(() => {if (valid(version)) fail('Shell connection timed out. Connect again to retry.');}, 15000);
      client.onopen = () => {
        if (!valid(version) || socket !== client) {client.close(); return;}
        clearTimeout(handshake); handshake = undefined;
        setState('connected'); layout(); scheduleRenew(version); term?.focus();
      };
      client.onmessage = event => {
        if (!valid(version) || socket !== client || !term || typeof event.data !== 'string') {if (valid(version)) fail('Shell sent an invalid response. Connect again.'); return;}
        let message: {type?:unknown;data?:unknown;seq?:unknown;exitCode?:unknown;code?:unknown};
        try {message = JSON.parse(event.data);} catch {fail('Shell sent an invalid response. Connect again.'); return;}
        if (message.type === 'output' && typeof message.data === 'string' && Number.isSafeInteger(message.seq) && message.seq === lastSequence + 1) {
          const bytes = encoder.encode(message.data).byteLength;
          queuedBytes += bytes; lastSequence = message.seq as number;
          if (queuedBytes > maxQueuedBytes) {fail('Shell output exceeded the display buffer. Reconnect explicitly.'); return;}
          const sequence = lastSequence;
          term.write(message.data, () => {
            if (generation !== version) return;
            queuedBytes = Math.max(0, queuedBytes - bytes);
            send({type:'ack', seq:sequence});
          });
        } else if (message.type === 'exit' && (message.exitCode === null || Number.isInteger(message.exitCode))) {
          term.options.disableStdin = true;
          term.write(`\r\n[Shell exited${message.exitCode === null ? '' : ` with code ${message.exitCode}`}]\r\n`);
          // Exit is terminal: stop renewing and release the one-shell reservation,
          // while retaining the rendered transcript until the next connection.
          void clearConnection(false);
          setState('disconnected', 'Shell exited. Connect again for a fresh session.');
        } else if (message.type === 'error' && typeof message.code === 'string') {
          fail('Shell session ended. Connect again for a fresh session.');
        } else fail('Shell sent an invalid response. Connect again.');
      };
      client.onerror = () => {if (valid(version) && !ended) fail('Shell connection failed. Connect again to retry.');};
      client.onclose = () => {if (generation === version) {const preserve = ended; clearConnection(!preserve); setState('disconnected', preserve ? 'Shell exited. Connect again for a fresh session.' : 'Shell connection ended. Connect again for a fresh session.');}};
      layout();
    } catch {if (valid(version)) fail('Shell connection unavailable. Connect again to retry.');}
  }
  connectButton.addEventListener('click', () => void connect()); stopButton.addEventListener('click', disconnect);
  const special: Record<string,string> = {'ctrl-c':'\x03',esc:'\x1b',tab:'\t',up:'\x1b[A',down:'\x1b[B',enter:'\r'};
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-shell-key]')) button.addEventListener('click', () => {if (special[button.dataset.shellKey!]) send({type:'input', data:special[button.dataset.shellKey!]}); term?.focus();});
  const observer = new ResizeObserver(layout); observer.observe(root); observer.observe(surface);
  const onVisibility = () => {if (document.hidden) disconnect(); else layout();};
  const onOffline = () => {if (state === 'connected' || state === 'connecting') fail('Network disconnected. Connect again when online.');};
  document.addEventListener('visibilitychange', onVisibility); window.addEventListener('offline', onOffline); window.addEventListener('pagehide', disconnect);
  window.addEventListener('resize', layout); window.visualViewport?.addEventListener('resize', layout); window.visualViewport?.addEventListener('scroll', layout);
  setState('disconnected');
  return {
    disconnect,
    setActive(value: boolean) {active = value; if (!active) disconnect(); else {setState(state); layout();}},
    destroy() {destroyed = true; disconnect(); cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('offline', onOffline); window.removeEventListener('pagehide', disconnect); window.removeEventListener('resize', layout); window.visualViewport?.removeEventListener('resize', layout); window.visualViewport?.removeEventListener('scroll', layout);},
  };
}
