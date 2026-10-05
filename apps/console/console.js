(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let token = '', bots = [], selected = null, currentRun = null, cursor = 0;
  let streamController = null, screenUrl = null, artifact = null, refreshTimer = null;
  let generation = 0, computerBusy = false;
  let authSession = 0, chatGPTConnected = false, chatGPTBusy = false, chatGPTAccount = null;
  const events = [];
  const pendingMessages = new Map(), pendingActions = new Map();
  let draftRunId = null;
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const botPath = (botId = selected?.id) => `/v1/bots/${encodeURIComponent(botId)}`;
  const errorText = (error) => error instanceof Error ? error.message : 'Request failed.';
  function showError(error) { $('app-error').textContent = errorText(error); }
  async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
    if (!token) throw new Error('Connect with an API token first.');
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error?.message || `Request failed (${response.status}).`);
    }
    return raw ? response : response.json();
  }
  async function guarded(fn) {
    $('app-error').textContent = '';
    try { return await fn(); } catch (error) { if (error.name !== 'AbortError') showError(error); }
  }
  function clearWarning() { $('computer-warning').hidden = true; $('computer-warning').textContent = ''; }
  function showWarning(message) { $('computer-warning').textContent = message; $('computer-warning').hidden = false; }
  function setComputerBusy(busy) {
    computerBusy = busy; document.querySelectorAll('[data-computer]').forEach((button) => { button.disabled = busy; });
  }
  function clearScreen() {
    if (screenUrl) URL.revokeObjectURL(screenUrl);
    screenUrl = null; artifact = null; clearWarning();
    $('screenshot').removeAttribute('src'); $('screenshot').hidden = true;
    $('screen-placeholder').hidden = false; $('screen-placeholder').textContent = 'Take a screenshot to inspect the desktop.'; $('download-artifact').hidden = true;
    $('screenshot-time').textContent = '';
  }
  function disconnect() {
    generation++; authSession++; token = ''; selected = null; currentRun = null; bots = [];
    chatGPTConnected = false; chatGPTAccount = null;
    $('chatgpt-status').textContent = 'Connection not checked.'; $('chatgpt-account').textContent = ''; $('chatgpt-account').hidden = true;
    $('chatgpt-verification').textContent = 'Model access has not been verified.'; $('chatgpt-error').textContent = '';
    $('verify-chatgpt').disabled = true; $('disconnect-chatgpt').hidden = true;
    streamController?.abort(); clearTimeout(refreshTimer); clearScreen();
    events.length = 0; pendingMessages.clear(); pendingActions.clear(); clearDraft(); $('token').value = ''; $('type-text').value = '';
    $('messages').replaceChildren(); $('approvals').replaceChildren(); $('activity-list').replaceChildren();
    $('bot-list').replaceChildren(); $('selected-name').textContent = ''; $('selected-model').textContent = '';
    $('message').value = ''; $('exec-command').value = ''; $('navigate-url').value = ''; $('key-name').value = '';
    $('create-form').reset(); $('file-path').value = '.';
    $('file-content').value = ''; $('computer-result').textContent = 'No actions yet.';
    $('app').hidden = true; $('login').hidden = false; $('disconnect').hidden = true;
    $('connection').textContent = 'Disconnected'; $('login-error').textContent = '';
  }
  function renderBots() {
    $('bot-list').replaceChildren();
    if (!bots.length) $('bot-list').append(el('p', 'hint', 'No bots yet. Create your first one below.'));
    for (const bot of bots) {
      const button = el('button', `bot-item${bot.id === selected?.id ? ' selected' : ''}`);
      button.type = 'button'; button.setAttribute('aria-pressed', String(bot.id === selected?.id));
      button.append(el('span', 'avatar', bot.name.slice(0, 1).toUpperCase()));
      const info = el('span'); info.append(el('span', 'bot-name', bot.name), el('small', '', bot.runtime));
      button.append(info); button.addEventListener('click', () => guarded(() => selectBot(bot))); $('bot-list').append(button);
    }
  }
  function renderChatGPT(status) {
    chatGPTConnected = status.connected === true;
    const account = status.account ? `${status.account.clientId}:${status.account.subject}` : null;
    if (account !== chatGPTAccount || !chatGPTConnected) $('chatgpt-verification').textContent = 'Model access has not been verified.';
    chatGPTAccount = account;
    if (chatGPTConnected && status.status === 'verified' && Number.isFinite(Date.parse(status.verifiedAt))) $('chatgpt-verification').textContent = `gpt-6.1-sol last verified ${new Date(status.verifiedAt).toLocaleString()}.`;
    $('chatgpt-status').textContent = chatGPTConnected ? 'Connected to your ChatGPT account.' : 'Not connected. Run the local login command.';
    $('chatgpt-account').textContent = status.account?.email || ''; $('chatgpt-account').hidden = !status.account?.email;
    $('verify-chatgpt').disabled = chatGPTBusy || !chatGPTConnected;
    $('disconnect-chatgpt').hidden = !chatGPTConnected;
  }
  async function chatGPTTask(task) {
    if (chatGPTBusy) return;
    const session = authSession; chatGPTBusy = true; $('chatgpt-error').textContent = '';
    for (const id of ['refresh-chatgpt', 'verify-chatgpt', 'disconnect-chatgpt']) $(id).disabled = true;
    try { await task(session); }
    catch (error) { if (session === authSession) $('chatgpt-error').textContent = errorText(error); }
    finally {
      chatGPTBusy = false; $('refresh-chatgpt').disabled = false; $('disconnect-chatgpt').disabled = false; $('verify-chatgpt').disabled = !chatGPTConnected;
    }
  }
  async function loadChatGPT(session = authSession) {
    const status = await request('/v1/connections/chatgpt');
    if (session === authSession) renderChatGPT(status);
  }
  async function loadBots() { const result = await request('/v1/bots'); bots = result.bots; renderBots(); }
  async function selectBot(bot) {
    generation++; const version = generation;
    streamController?.abort(); clearTimeout(refreshTimer); clearScreen();
    selected = bot; currentRun = null; cursor = 0; events.length = 0; clearDraft();
    $('empty').hidden = true; $('bot-workspace').hidden = false;
    $('selected-name').textContent = bot.name; $('selected-model').textContent = `${bot.runtime} · ${bot.model}`;
    $('messages').replaceChildren(); $('approvals').replaceChildren(); $('activity-list').replaceChildren();
    $('event-count').textContent = '0'; $('computer-result').textContent = 'No actions yet.';
    $('computer-status').textContent = 'Load its status to inspect available capabilities.';
    $('file-content').value = ''; $('file-path').value = '.'; $('type-text').value = '';
    $('app-error').textContent = ''; updateRun(null); renderBots();
    streamController = new AbortController();
    void streamEvents(bot.id, version, streamController.signal);
    await Promise.all([loadMessages(version), loadApprovals(version)]);
  }
  function clearDraft() {
    draftRunId = null; $('streaming-message').hidden = true; $('streaming-text').textContent = '';
  }
  function updateRun(run) {
    currentRun = run;
    $('run-status').textContent = run ? run.status.replaceAll('_', ' ') : 'Ready';
    $('cancel-run').hidden = !run || terminal.has(run.status);
    $('run-error').textContent = run?.error || ''; $('run-error').hidden = !run?.error;
    if (run && terminal.has(run.status) && draftRunId === run.id) clearDraft();
  }
  async function loadMessages(version = generation) {
    const botId = selected?.id;
    if (!botId) return;
    const result = await request(`${botPath(botId)}/messages`);
    if (version !== generation) return;
    const list = $('messages'); const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren();
    if (!result.messages.length) list.append(el('p', 'hint', 'This bot’s conversation starts with your first message.'));
    for (const message of result.messages) {
      const block = el('article', `message ${['user', 'assistant', 'tool', 'system'].includes(message.role) ? message.role : ''}`);
      const meta = el('div', 'message-meta');
      meta.append(el('span', '', message.role === 'assistant' ? selected.name : message.role.toUpperCase()), el('time', '', time(message.createdAt)));
      block.append(meta, el('p', 'message-text', message.text)); list.append(block);
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
    const latestRun = [...result.messages].reverse().find((message) => message.runId)?.runId;
    if (latestRun && (!currentRun || latestRun === currentRun.id || terminal.has(currentRun.status))) {
      const detail = await request(`${botPath(botId)}/runs/${encodeURIComponent(latestRun)}`);
      if (version === generation && (!currentRun || currentRun.id === latestRun || terminal.has(currentRun.status))) updateRun(detail.run);
    }
  }
  function actionSummary(action) {
    if (action.type === 'type') return JSON.stringify({ type: 'type', text: `[${String(action.text || '').length} characters hidden]` }, null, 2);
    return JSON.stringify(action, null, 2);
  }
  async function loadApprovals(version = generation) {
    const botId = selected?.id; if (!botId) return;
    const result = await request(`${botPath(botId)}/approvals`);
    if (version !== generation) return;
    $('approvals').replaceChildren();
    for (const approval of result.approvals.filter((item) => item.status === 'pending' || item.status === 'executing')) {
      const card = el('article', 'approval');
      card.append(el('h3', '', approval.status === 'executing' ? 'Approved action is executing' : 'This bot needs your approval'), el('pre', '', actionSummary(approval.action)), el('p', 'hint', `Expires ${new Date(approval.expiresAt).toLocaleString()}`));
      if (approval.status === 'pending') {
        const controls = el('div', 'row');
        for (const decision of ['deny', 'approve']) {
          const button = el('button', decision === 'deny' ? 'quiet' : '', decision === 'approve' ? 'Approve action' : 'Deny');
          button.type = 'button';
          button.addEventListener('click', () => guarded(async () => {
            for (const item of controls.querySelectorAll('button')) item.disabled = true;
            try { await request(`${botPath(botId)}/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: { decision } }); }
            finally { await loadApprovals(version); }
          }));
          controls.append(button);
        }
        card.append(controls);
      }
      $('approvals').append(card);
    }
  }
  function scheduleRefresh(version) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (version === generation) void guarded(() => Promise.all([loadMessages(version), loadApprovals(version)]));
    }, 250);
  }
  function redact(value, key = '') {
    if (/token|secret|password|authorization|credential/i.test(key)) return '[hidden]';
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [name, item] of Object.entries(value)) result[name] = value.type === 'type' && name === 'text' ? '[hidden]' : redact(item, name);
      return result;
    }
    return value;
  }
  function recordEvent(event, version) {
    if (version !== generation) return;
    if (!Number.isSafeInteger(event.id) || event.id <= cursor) return;
    cursor = event.id; events.push(event); if (events.length > 200) events.shift();
    $('event-count').textContent = String(events.length);
    const row = el('article', 'event');
    const title = el('div', 'event-title'); title.append(el('span', '', `#${event.id} ${event.type}`), el('span', 'muted', time(event.createdAt)));
    const serialized = JSON.stringify(redact(event.data), null, 2);
    row.append(title, el('pre', '', serialized.length > 8000 ? `${serialized.slice(0, 8000)}\n…` : serialized));
    $('activity-list').prepend(row);
    while ($('activity-list').children.length > 200) $('activity-list').lastElementChild.remove();
    if (event.type === 'message.delta' && typeof event.data.delta === 'string') {
      if (draftRunId !== event.runId) { clearDraft(); draftRunId = event.runId; }
      $('streaming-message').hidden = false; $('streaming-text').textContent += event.data.delta;
    } else {
      if ((event.type === 'message.created' && event.data.message?.role === 'assistant') || (event.type === 'message' && event.data.role === 'assistant')) clearDraft();
      if (event.type === 'run.updated' && event.data.run) updateRun(event.data.run);
      scheduleRefresh(version);
    }
  }
  const pause = (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  });
  async function streamEvents(botId, version, signal) {
    let delay = 1000;
    while (!signal.aborted && version === generation) {
      $('stream-state').textContent = cursor ? 'Reconnecting…' : 'Connecting…';
      try {
        const response = await request(`${botPath(botId)}/events?after=${cursor}`, { signal, raw: true });
        if (!response.body) throw new Error('Streaming is unavailable.');
        $('stream-state').textContent = 'Live'; delay = 1000;
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = '', dataLines = [];
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read(); if (done) break;
            pending += decoder.decode(value, { stream: true });
            let index;
            while ((index = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
              if (!line) {
                if (dataLines.length) {
                  try { recordEvent(JSON.parse(dataLines.join('\n')), version); } catch { /* Ignore malformed non-product events. */ }
                  dataLines = [];
                }
              } else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch (error) {
        if (signal.aborted || version !== generation) return;
        $('stream-state').textContent = 'Stream interrupted';
      }
      await pause(delay, signal); delay = Math.min(delay * 2, 15000);
    }
  }
  async function computerStatus() {
    const version = generation;
    const { computer } = await request(`${botPath()}/computer`);
    if (version === generation) $('computer-status').textContent = `${computer.state} · ${computer.provider} · ${computer.capabilities.join(', ') || 'No capabilities advertised'}${computer.lastCheckpointId ? ' · last confirmed checkpoint available' : ''}`;
  }
  async function showArtifact(result, botId, version) {
    if (!result.artifactId || version !== generation) return;
    artifact = { id: result.artifactId, botId }; $('download-artifact').hidden = false;
    if (['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType)) {
      const response = await request(`${botPath(botId)}/artifacts/${encodeURIComponent(result.artifactId)}`, { raw: true });
      const blob = await response.blob(); if (version !== generation) return;
      if (screenUrl) URL.revokeObjectURL(screenUrl);
      screenUrl = URL.createObjectURL(blob); $('screenshot').src = screenUrl; $('screenshot').hidden = false; $('screen-placeholder').hidden = true;
      $('screenshot-time').textContent = `Captured ${time(new Date().toISOString())}`;
    }
  }
  async function computerAction(action) {
    if (!selected || computerBusy) return;
    const version = generation, botId = selected.id;
    setComputerBusy(true); clearWarning();
    $('computer-result').textContent = `Running ${action.type}…`;
    try {
      const actionKey = `${botId}:${JSON.stringify(action)}`;
      const operationId = pendingActions.get(actionKey) || crypto.randomUUID();
      pendingActions.set(actionKey, operationId);
      const { result } = await request(`${botPath(botId)}/computer/actions`, { method: 'POST', body: { operationId, action } });
      pendingActions.delete(actionKey);
      if (version !== generation) return;
      $('computer-result').textContent = JSON.stringify(result, null, 2);
      if (result.status === 'completed' && result.error) showWarning(`Action completed with a warning: ${result.error}`);
      if (action.type === 'checkpoint' && result.status === 'completed' && !result.checkpointId) showWarning('No checkpoint reference was returned. Durable storage is not confirmed.');
      if (action.type === 'readFile' && result.status === 'completed') $('file-content').value = result.output || '';
      await showArtifact(result, botId, version);
      await computerStatus();
      if (result.status !== 'completed') throw new Error(result.error || `Action ${result.status}. It was not retried.`);
    } catch (error) {
      if (version === generation) { $('computer-result').textContent = errorText(error); throw error; }
    } finally {
      setComputerBusy(false);
    }
  }
  async function suspendComputer() {
    if (!selected || computerBusy) return;
    const version = generation, botId = selected.id;
    setComputerBusy(true); clearWarning(); $('computer-result').textContent = 'Saving workspace and suspending computer…';
    try {
      const { computer } = await request(`${botPath(botId)}/computer/suspend`, { method: 'POST', body: {} });
      if (version !== generation) return;
      clearScreen(); $('computer-result').textContent = JSON.stringify({ computer }, null, 2);
      if (!computer.lastCheckpointId) showWarning('No checkpoint reference was returned. Durable storage is not confirmed.');
      $('screen-placeholder').textContent = 'Computer suspended. The next action restores its workspace.';
      await computerStatus();
    } finally { setComputerBusy(false); }
  }
  function bindForm(id, fn) { $(id).addEventListener('submit', (event) => { event.preventDefault(); void guarded(fn); }); }
  $('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
    authSession++; token = $('token').value.trim();
    try {
      await loadBots(); $('token').value = ''; $('login').hidden = true; $('app').hidden = false; $('disconnect').hidden = false; $('connection').textContent = 'Authenticated';
      void chatGPTTask(loadChatGPT);
      if (bots.length) await selectBot(bots[0]);
    } catch (error) { token = ''; $('login-error').textContent = errorText(error); }
    finally { button.disabled = false; }
  });
  $('disconnect').addEventListener('click', disconnect);
  $('refresh-chatgpt').addEventListener('click', () => chatGPTTask(loadChatGPT));
  $('copy-chatgpt-login').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('npm run chatgpt:login'); $('chatgpt-verification').textContent = 'Login command copied. Run it in your local Timber checkout.'; }
    catch { $('chatgpt-error').textContent = 'Copy the login command above and run it in your local Timber checkout.'; }
  });
  $('verify-chatgpt').addEventListener('click', () => chatGPTTask(async (session) => {
    $('chatgpt-verification').textContent = 'Testing gpt-6.1-sol with one small real request…';
    try {
      const result = await request('/v1/connections/chatgpt/verify', { method: 'POST', body: {} });
      if (session !== authSession) return;
      if (result.ok !== true || result.model !== 'gpt-6.1-sol') throw new Error('The backend did not confirm gpt-6.1-sol access.');
      $('chatgpt-verification').textContent = 'Verified: gpt-6.1-sol completed a real request.';
    } catch (error) {
      if (session === authSession) $('chatgpt-verification').textContent = 'Model access was not verified.';
      throw error;
    }
  }));
  $('disconnect-chatgpt').addEventListener('click', () => chatGPTTask(async (session) => {
    const status = await request('/v1/connections/chatgpt', { method: 'DELETE' });
    if (session !== authSession) return;
    renderChatGPT(status);
    $('chatgpt-verification').textContent = status.revoked === true
      ? 'ChatGPT disconnected and its renewable session revoked.'
      : 'Cloud credentials removed. Remote revocation was not confirmed; disconnect Timber in ChatGPT Settings.';
  }));
  $('reload-bots').addEventListener('click', () => guarded(loadBots));
  bindForm('create-form', async () => {
    const button = $('create-form').querySelector('button'); button.disabled = true;
    try {
      const body = { name: $('bot-name').value.trim(), instructions: $('bot-instructions').value.trim() };
      if ($('bot-model').value.trim()) body.model = $('bot-model').value.trim();
      const { bot } = await request('/v1/bots', { method: 'POST', body });
      $('create-form').reset(); await loadBots(); await selectBot(bot);
    } finally { button.disabled = false; }
  });
  bindForm('message-form', async () => {
    const text = $('message').value.trim(); if (!text || !selected) return;
    const version = generation, botId = selected.id, button = $('message-form').querySelector('button'); button.disabled = true;
    try {
      const previous = pendingMessages.get(botId);
      const operationId = previous?.text === text ? previous.operationId : crypto.randomUUID();
      pendingMessages.set(botId, { text, operationId });
      const { run } = await request(`${botPath(botId)}/messages`, { method: 'POST', body: { text, operationId } });
      pendingMessages.delete(botId);
      if (version !== generation) return;
      updateRun(run); if ($('message').value.trim() === text) $('message').value = '';
      await loadMessages(version);
    } finally { button.disabled = false; }
  });
  $('message').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!$('message-form').querySelector('button').disabled) $('message-form').requestSubmit(); } });
  $('cancel-run').addEventListener('click', () => guarded(async () => {
    if (!currentRun) return; const version = generation;
    const { run } = await request(`${botPath()}/runs/${encodeURIComponent(currentRun.id)}/cancel`, { method: 'POST' });
    if (version === generation) updateRun(run);
  }));
  document.querySelectorAll('[data-panel]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-panel]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); $(`panel-${item.dataset.panel}`).hidden = !active; });
    if (button.dataset.panel === 'computer' && selected) void guarded(computerStatus);
  }));
  $('refresh-history').addEventListener('click', () => guarded(() => Promise.all([loadMessages(), loadApprovals()])));
  $('refresh-computer').addEventListener('click', () => guarded(computerStatus));
  $('take-screenshot').addEventListener('click', () => guarded(() => computerAction({ type: 'screenshot' })));
  $('checkpoint').addEventListener('click', () => guarded(() => computerAction({ type: 'checkpoint' })));
  $('suspend-computer').addEventListener('click', () => guarded(suspendComputer));
  bindForm('navigate-form', () => computerAction({ type: 'navigate', url: $('navigate-url').value }));
  bindForm('click-form', () => computerAction({ type: 'click', x: Number($('click-x').value), y: Number($('click-y').value), button: $('click-button').value }));
  bindForm('type-form', async () => { const text = $('type-text').value; $('type-text').value = ''; await computerAction({ type: 'type', text }); });
  bindForm('key-form', () => computerAction({ type: 'key', key: $('key-name').value }));
  for (const direction of ['up', 'down']) $(`scroll-${direction}`).addEventListener('click', () => guarded(() => computerAction({ type: 'scroll', direction, amount: 3 })));
  bindForm('exec-form', () => computerAction({ type: 'exec', command: $('exec-command').value, timeoutMs: 30000 }));
  $('list-files').addEventListener('click', () => guarded(() => computerAction({ type: 'listFiles', path: $('file-path').value })));
  $('read-file').addEventListener('click', () => guarded(() => computerAction({ type: 'readFile', path: $('file-path').value })));
  $('write-file').addEventListener('click', () => guarded(() => computerAction({ type: 'writeFile', path: $('file-path').value, content: $('file-content').value })));
  $('download-artifact').addEventListener('click', () => guarded(async () => {
    if (!artifact) return;
    const { id, botId } = artifact;
    const response = await request(`${botPath(botId)}/artifacts/${encodeURIComponent(id)}`, { raw: true });
    const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `artifact-${id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }));
  window.addEventListener('pagehide', disconnect);
})();
