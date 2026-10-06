import './src/styles.css';
import { mountChat } from './src/chat.tsx';

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const guiActions = new Set(['navigate', 'click', 'type', 'key', 'scroll']);
  const drafts = new Map(), pendingMessages = new Map(), pendingActions = new Map(), computerPending = new Map(), stopping = new Set(), approvalWork = new Map(), approvalFeedback = new Map();
  let token = '', bots = [], selected = null, currentRun = null, generation = 0, authSession = 0;
  let sessionController = new AbortController(), streamController, refreshTimer, progressTimer, computerStatusTimer;
  let computerStatusRequest = 0;
  let messages = [], approvals = [], runs = new Map(), activeRunIds = new Set(), nextCursor = null, olderPagesLoaded = false, loadingOlderRuns = false, runFilter = null, runRevision = 0, runsRequest = 0, messagesRequest = 0, approvalsRequest = 0;
  let cursor = 0, boundary = '', events = [], streamDrafts = new Map(), chatLoading = false, focusApproval = 0, screenUrl = null, artifact = null, directoryPath = '.';
  let chatGPTConnected = false, chatGPTBusy = false, chatGPTAccount = null, editBotId = null, sendBusy = new Set();
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const botPath = (id = selected?.id) => `/v1/bots/${encodeURIComponent(id)}`;
  const errorText = (error) => error instanceof Error ? error.message : 'Request failed.';
  const time = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = (value) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const statusLabel = (status) => String(status || 'ready').replaceAll('_', ' ');
  const statusBadge = (status) => { const node = el('span', 'status', statusLabel(status)); node.dataset.status = status; return node; };
  const validView = (version) => version === generation && Boolean(token);
  const chat = mountChat($('chat-root'), {
    onDraft: (botId, text) => { if (selected?.id === botId && token) { drafts.set(botId, text); renderMessages(); } },
    onSend: (botId, text) => { void sendMessage(botId, text); },
    onRetry: (botId, operationId) => {
      if (selected?.id !== botId || !token) return;
      const run = [...runs.values()].find(item => item.operationId === operationId && item.status === 'queued' && item.error?.includes('Retry this message'));
      const message = run && messages.find(item => item.role === 'user' && item.runId === run.id);
      const delivery = pendingMessages.get(operationId);
      if (run && (message || delivery?.botId === botId)) { void retryAdmission(botId, run, message?.text || delivery.text); return; }
      if (delivery?.botId === botId) void sendMessage(botId, delivery.text, operationId);
    },
    onDecision: (botId, approvalId, decision, allowComputer) => { if (selected?.id !== botId) return; const approval = approvals.find(item => item.id === approvalId); if (approval) void decideApproval(botId, approval, decision, allowComputer); },
    onClearFilter: () => { runFilter = null; renderMessages(); },
    onStop: (botId, runId) => { if (selected?.id === botId) void guarded(() => cancelRun(runId)); },
  });
  function showError(error) { if (token) $('app-error').textContent = errorText(error); }
  async function guarded(fn) { $('app-error').textContent = ''; try { return await fn(); } catch (error) { if (error.name !== 'AbortError') showError(error); } }
  async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
    if (!token) throw new Error('Reconnect with your Timber API token.');
    const session = authSession, headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, sessionController.signal]) : sessionController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error(method === 'GET' ? 'Connection lost. Check your network, then refresh or reconnect.' : 'The response was lost. The action may have been accepted. Inspect its state before retrying; nothing was retried automatically.'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      if (response.status === 401 && !String(detail.error?.code || '').startsWith('chatgpt_') && session === authSession) disconnect('Your API token was rejected or expired. Enter the current token to reconnect.');
      const error = new Error(detail.error?.message || `Request failed (${response.status}).`); error.status = response.status; throw error;
    }
    if (session !== authSession) throw new DOMException('The session ended.', 'AbortError');
    if (raw) return response;
    const result = await response.json();
    if (session !== authSession) throw new DOMException('The session ended.', 'AbortError');
    return result;
  }
  function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close()); }
  function clearScreen() {
    if (screenUrl) URL.revokeObjectURL(screenUrl); screenUrl = null; artifact = null;
    $('screenshot').removeAttribute('src'); $('screenshot').hidden = true; $('screen-placeholder').hidden = false;
    $('download-artifact').hidden = true; $('screenshot-time').textContent = 'Still screenshots. No periodic refresh or background wake-ups.';
    $('click-mode').checked = false; $('auto-screenshot').checked = false; document.querySelector('.screen').classList.remove('click-enabled');
  }
  function disconnect(message = '') {
    stopComputerStatus(); generation++; authSession++; token = ''; sessionController.abort(); streamController?.abort(); clearTimeout(refreshTimer); clearInterval(progressTimer); progressTimer = null;
    selected = null; currentRun = null; bots = []; messages = []; approvals = []; runs.clear(); activeRunIds.clear(); streamDrafts.clear(); events = [];
    drafts.clear(); pendingMessages.clear(); pendingActions.clear(); computerPending.clear(); sendBusy.clear(); stopping.clear(); approvalWork.clear(); approvalFeedback.clear(); closeDialogs(); clearScreen();
    chatGPTConnected = false; chatGPTAccount = null; chatGPTBusy = false;
    chat.clear();
    for (const id of ['activity-list', 'bot-list', 'run-list', 'file-list']) $(id).replaceChildren();
    for (const id of ['token', 'type-text', 'exec-command', 'navigate-url', 'key-name', 'file-content', 'bot-search']) $(id).value = '';
    $('create-form').reset(); $('edit-form').reset(); $('file-path').value = '.'; $('computer-result').textContent = 'No actions yet.';
    $('result-raw').textContent = ''; $('result-details').hidden = true; $('computer-warning').hidden = true; $('computer-progress').hidden = true;
    $('chatgpt-status').textContent = 'Connection not checked.'; $('chatgpt-account').textContent = ''; $('chatgpt-account').hidden = true;
    $('chatgpt-verification').textContent = 'Model access has not been verified.'; $('chatgpt-error').textContent = ''; $('disconnect-chatgpt').hidden = true; $('verify-chatgpt').disabled = true;
    $('app').hidden = true; $('login').hidden = false; $('disconnect').hidden = true; $('settings-button').hidden = true;
    $('connection').textContent = 'Disconnected'; $('login-error').textContent = typeof message === 'string' ? message : '';
  }
  function emptyState(title, detail) { const node = el('div', 'empty-state'); node.append(el('strong', '', title), el('p', '', detail)); return node; }
  function renderBots() {
    const query = $('bot-search').value.trim().toLowerCase(), matching = bots.filter((bot) => `${bot.name} ${bot.instructions}`.toLowerCase().includes(query));
    $('bot-count').textContent = String(bots.length); $('bot-list').replaceChildren();
    if (!matching.length) { $('bot-list').append(emptyState(bots.length ? 'No matching bots' : 'Your team starts here', bots.length ? 'Try another name or keyword.' : 'Use New bot to create one.')); return; }
    for (const bot of matching) {
      const button = el('button', `bot-item${bot.id === selected?.id ? ' selected' : ''}`); button.type = 'button'; button.dataset.botId = bot.id;
      button.setAttribute('aria-pressed', String(bot.id === selected?.id)); button.append(el('span', 'avatar', bot.name.slice(0, 1).toUpperCase()));
      const info = el('span', 'bot-info'); info.append(el('span', 'bot-name', bot.name), el('small', '', bot.instructions?.trim().split('\n')[0] || 'A persistent cloud bot'));
      button.append(info); button.addEventListener('click', () => guarded(() => selectBot(bot))); $('bot-list').append(button);
    }
  }
  async function loadBots() { const session = authSession, result = await request('/v1/bots'); if (session !== authSession) return; bots = result.bots; renderBots(); }
  function updateBotHeader() { $('selected-name').textContent = selected.name; $('selected-avatar').textContent = selected.name.slice(0, 1).toUpperCase(); $('selected-model').textContent = `${selected.runtime} · ${selected.model}`; $('selected-computer-mode').textContent = selected.computerApprovalMode === 'automatic' ? 'Computer · Use authorized' : 'Computer · Ask for each action'; }
  function chosenHash() { const value = new URLSearchParams(location.hash.slice(1)).get('bot'); return /^[a-f\d-]{36}$/i.test(value || '') ? value : null; }
  async function selectBot(bot) {
    if (selected?.id === bot.id) return;
    stopComputerStatus(); generation++; const version = generation; streamController?.abort(); clearTimeout(refreshTimer); clearScreen();
    selected = bot; chatLoading = true; currentRun = null; cursor = 0; boundary = ''; events = []; messages = []; approvals = []; runs = new Map(); activeRunIds = new Set(); streamDrafts = new Map(); nextCursor = null; olderPagesLoaded = false; loadingOlderRuns = false; runFilter = null; runRevision = 0;
    history.replaceState(null, '', `${location.pathname}${location.search}#bot=${encodeURIComponent(bot.id)}`);
    $('empty').hidden = true; $('bot-workspace').hidden = false; updateBotHeader(); renderBots();
    for (const id of ['activity-list', 'run-list']) $(id).replaceChildren();
    $('event-count').textContent = '0';
    $('computer-result').textContent = 'No actions yet.'; $('result-details').hidden = true; $('computer-warning').hidden = true;
    $('computer-status').textContent = 'Load status to inspect the environment.'; $('file-path').value = '.'; directoryPath = '.';
    $('file-content').value = ''; $('type-text').value = ''; $('file-list').replaceChildren(el('p', 'hint', 'Browse to load files. This may wake the computer.'));
    $('app-error').textContent = ''; $('approval-shortcut').hidden = true; renderCurrentRun(); renderStreamDraft(); renderProgress();
    try { await Promise.all([loadMessages(version), loadRuns(version), loadApprovals(version)]); }
    finally { if (validView(version)) { chatLoading = false; renderMessages(); startStream(); if (!$('panel-computer').hidden) void guarded(computerStatus); } }
  }
  function effectiveApprovals() {
    return approvals.map(approval => {
      const work = approvalWork.get(`${selected.id}:${approval.id}`), cached = work?.approval;
      const value = cached && (approval.status === 'pending' || (approval.status === 'executing' && cached.status !== 'pending')) ? cached : approval;
      return { ...value, status: value.status === 'pending' && Date.parse(value.expiresAt) <= Date.now() ? 'expired' : value.status, busy: work?.busy === true };
    });
  }
  function reconcileDeliveries(serverRuns = []) {
    for (const [operationId, delivery] of pendingMessages) {
      if (delivery.botId !== selected?.id) continue;
      const run = serverRuns.find(item => item.operationId === operationId);
      if (run) {
        const newlyAccepted = delivery.state !== 'accepted';
        delivery.runId = run.id; delivery.runStatus = run.status; delivery.state = 'accepted'; delete delivery.error;
        if (newlyAccepted && (drafts.get(delivery.botId) || '').trim() === delivery.text) drafts.delete(delivery.botId);
      }
      if (delivery.runId && messages.some(message => message.role === 'user' && message.runId === delivery.runId)) pendingMessages.delete(operationId);
    }
  }
  function renderMessages() {
    if (!selected || !token) return;
    const visibleApprovals = effectiveApprovals(), pending = visibleApprovals.filter(approval => approval.status === 'pending');
    $('approval-count').textContent = String(pending.length); $('approval-shortcut').hidden = !pending.length;
    const stream = [...streamDrafts.entries()].find(([id, text]) => text && activeRunIds.has(id) && !terminal.has(runs.get(id)?.status) && (!runFilter || id === runFilter));
    chat.update({ bot: selected, messages, runs: [...runs.values()], approvals: visibleApprovals, events: events.filter(event => ['tool.started', 'tool.completed'].includes(event.type)).map(event => ({...event, data: redact(event.data)})),
      deliveries: [...pendingMessages.values()].filter(delivery => delivery.botId === selected.id).map(delivery => ({...delivery})), draft: drafts.get(selected.id) || '', sending: sendBusy.has(selected.id), loading: chatLoading,
      currentRun, runFilter, focusApproval, stream: stream ? {runId: stream[0], text: stream[1]} : null, feedback: approvalFeedback.get(selected.id) });
  }
  async function sendMessage(botId, rawText, retryOperationId) {
    const text = rawText.trim(); if (!token || selected?.id !== botId || !text || sendBusy.has(botId)) return;
    const session = authSession;
    const previous = retryOperationId ? pendingMessages.get(retryOperationId) : [...pendingMessages.values()].find(item => item.botId === botId && item.text === text && ['unknown', 'rejected'].includes(item.state));
    if (previous && (previous.botId !== botId || previous.text !== text || previous.state === 'accepted' || previous.state === 'sending')) return;
    const delivery = previous || { botId, operationId: crypto.randomUUID(), text, createdAt: new Date().toISOString() };
    delivery.state = 'sending'; delete delivery.error; pendingMessages.set(delivery.operationId, delivery); sendBusy.add(botId); renderMessages();
    try {
      const {run} = await request(`${botPath(botId)}/messages`, {method: 'POST', body: {text, operationId: delivery.operationId}});
      if (session !== authSession) return;
      if (!run || typeof run.id !== 'string' || !run.id || run.botId !== botId || run.operationId !== delivery.operationId || !['queued', 'running', 'waiting_approval', ...terminal].includes(run.status)) throw new Error('The server acknowledgment could not be verified. Your message may have been accepted. Retry sending to check the same request safely.');
      delivery.state = 'accepted'; delivery.runId = run.id; delivery.runStatus = run.status;
      if ((drafts.get(botId) || '').trim() === text) drafts.delete(botId);
      if (selected?.id === botId) { mergeRun(run); if (!terminal.has(run.status)) activeRunIds.add(run.id); runRevision++; runFilter = null; reconcileDeliveries([run]); renderRuns(); scheduleRefresh(generation); }
    } catch (error) {
      if (session !== authSession || error.name === 'AbortError' || delivery.runId) return;
      delivery.state = !error.status || error.status >= 500 ? 'unknown' : 'rejected'; delivery.error = errorText(error); delivery.canRetry = !error.status || error.status >= 500 || error.status === 429;
    } finally { if (session === authSession) { sendBusy.delete(botId); if (selected?.id === botId) renderMessages(); } }
  }
  async function retryAdmission(botId, run, text) {
    if (!token || selected?.id !== botId || sendBusy.has(botId)) return;
    const session = authSession; sendBusy.add(botId); renderMessages();
    try {
      const result = await request(`${botPath(botId)}/messages`, {method: 'POST', body: {text, operationId: run.operationId}});
      if (session !== authSession) return;
      if (result.run?.id !== run.id || result.run.botId !== botId || result.run.operationId !== run.operationId || !['queued', 'running', 'waiting_approval', ...terminal].includes(result.run.status)) throw new Error('Delivery retry was not confirmed. Inspect this run before trying again.');
      if (selected?.id === botId) {mergeRun(result.run); reconcileDeliveries([result.run]); renderRuns(); scheduleRefresh(generation);}
    } catch (error) { if (session === authSession && selected?.id === botId && error.name !== 'AbortError') showError(error); }
    finally {if (session === authSession) {sendBusy.delete(botId); if (selected?.id === botId) renderMessages();}}
  }
  async function loadMessages(version = generation) { const id = selected?.id, sequence = ++messagesRequest; if (!id) return; const result = await request(`${botPath(id)}/messages`); if (!validView(version) || sequence !== messagesRequest) return; messages = result.messages; reconcileDeliveries(); renderMessages(); }
  function mergeRun(run, source = 'snapshot') {
    if (!run?.id || run.botId !== selected?.id) return false;
    const prior = runs.get(run.id);
    if (prior) {
      if (terminal.has(prior.status) && !terminal.has(run.status)) return false;
      if (Date.parse(run.updatedAt) < Date.parse(prior.updatedAt)) return false;
      if (source === 'event' && run.updatedAt === prior.updatedAt && run.status !== prior.status && prior.status !== 'queued' && !terminal.has(run.status)) return false;
    }
    runs.set(run.id, run); if (terminal.has(run.status)) { activeRunIds.delete(run.id); streamDrafts.delete(run.id); } return true;
  }
  const sortedRuns = () => [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  function renderCurrentRun() {
    const active = sortedRuns().filter((run) => activeRunIds.has(run.id) && !terminal.has(run.status));
    currentRun = active.find((run) => run.status === 'running') || active.find((run) => run.status === 'waiting_approval') || active[0] || sortedRuns()[0] || null;
    $('run-status').textContent = currentRun ? statusLabel(currentRun.status) : 'Ready'; $('run-status').dataset.status = currentRun?.status || 'ready';
    $('cancel-run').hidden = !currentRun || terminal.has(currentRun.status); $('cancel-run').disabled = currentRun ? stopping.has(currentRun.id) : false;
    $('active-run-count').hidden = !active.length; $('active-run-count').textContent = String(active.length);
    $('run-error').textContent = currentRun?.error || ''; $('run-error').hidden = !currentRun?.error; renderStreamDraft();
  }
  function renderRuns() {
    $('run-list').replaceChildren(); const ordered = sortedRuns();
    if (!ordered.length) $('run-list').append(emptyState('No runs yet', 'Send a message to start this bot’s first task.'));
    for (const run of ordered) {
      const card = el('article', 'run-card'); card.dataset.runId = run.id;
      const top = el('div', 'run-top'); top.append(statusBadge(run.status), el('time', 'run-date', date(run.createdAt)), el('span', 'spacer'), el('span', 'run-id', run.id.slice(0, 8))); card.append(top);
      if (run.error) card.append(el('p', 'error', run.error));
      const controls = el('div', 'row'); const view = el('button', 'quiet', 'View messages'); view.type = 'button'; view.addEventListener('click', () => { runFilter = run.id; showPanel('conversation'); renderMessages(); renderStreamDraft(); }); controls.append(view);
      if (!terminal.has(run.status)) { const stop = el('button', 'quiet', stopping.has(run.id) ? 'Stopping…' : 'Stop run'); stop.type = 'button'; stop.dataset.runCancel = run.id; stop.disabled = stopping.has(run.id); stop.addEventListener('click', () => guarded(() => cancelRun(run.id))); controls.append(stop); }
      card.append(controls); $('run-list').append(card);
    }
    $('load-more-runs').hidden = !nextCursor; renderCurrentRun();
  }
  async function loadRuns(version = generation, append = false) {
    if (!selected || loadingOlderRuns || (append && !nextCursor)) return;
    const id = selected.id, sequence = ++runsRequest, revision = runRevision, params = new URLSearchParams({ limit: '30' }); if (append) params.set('before', nextCursor);
    if (append) loadingOlderRuns = true;
    $('load-more-runs').disabled = true;
    try {
      const result = await request(`${botPath(id)}/runs?${params}`); if (!validView(version) || sequence !== runsRequest) return;
      for (const run of [...result.runs, ...result.activeRuns]) mergeRun(run);
      reconcileDeliveries([...result.runs, ...result.activeRuns]);
      const active = new Set(result.activeRuns.map((run) => run.id));
      if (revision === runRevision) activeRunIds = active; else for (const runId of active) if (!terminal.has(runs.get(runId)?.status)) activeRunIds.add(runId);
      if (!append) boundary = result.runs[0]?.createdAt || boundary;
      // Latest-page refreshes must not move the older-history cursor backwards.
      if (append) { olderPagesLoaded = true; nextCursor = result.nextCursor; }
      else if (!olderPagesLoaded && result.runs.length) nextCursor = result.nextCursor;
      renderRuns();
    } finally { if (validView(version) && sequence === runsRequest) { if (append) loadingOlderRuns = false; $('load-more-runs').disabled = false; } }
  }
  async function cancelRun(id) {
    if (!selected || stopping.has(id)) return; const version = generation, session = authSession, botId = selected.id; stopping.add(id); renderRuns();
    try { const { run } = await request(`${botPath(botId)}/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); if (validView(version)) { mergeRun(run); runRevision++; renderRuns(); scheduleRefresh(version); } }
    finally { if (session === authSession) stopping.delete(id); if (validView(version)) renderRuns(); }
  }
  function actionSummary(action) { return JSON.stringify(action.type === 'type' ? { type: 'type', text: `[${String(action.text || '').length} characters hidden]` } : action, null, 2); }
  async function decideApproval(botId, approval, decision, allowComputer = false) {
    const key = `${botId}:${approval.id}`, session = authSession;
    if (!token || approvalWork.get(key)?.busy || approvalWork.get(key)?.approval) return;
    const work = { busy: true }; approvalWork.set(key, work); approvalFeedback.delete(botId);
    if (selected?.id === botId) renderApprovals();
    let permissionSaved = false;
    try {
      if (allowComputer) {
        const { bot } = await request(botPath(botId), { method: 'PATCH', body: { computerApprovalMode: 'automatic' } });
        if (session !== authSession) return;
        permissionSaved = true; bots = bots.map((item) => item.id === botId ? bot : item);
        if (selected?.id === botId) { selected = bot; updateBotHeader(); renderApprovals(); } renderBots();
      }
      if (session !== authSession || !token) return;
      const result = await request(`${botPath(botId)}/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: { decision } });
      if (session !== authSession) return;
      work.approval = result.approval;
      const failed = ['failed', 'interrupted'].includes(result.approval.status);
      approvalFeedback.set(botId, { createdAt: new Date().toISOString(), runId: approval.runId, error: failed, text: `${permissionSaved ? 'Computer use is allowed for future actions. ' : ''}${failed ? `This action ${result.approval.status}: ${result.approval.result?.error || 'Inspect its effects before retrying.'}` : decision === 'deny' ? 'Request denied.' : 'This request was approved.'}` });
    } catch (error) {
      if (session !== authSession || error.name === 'AbortError') return;
      const explanation = permissionSaved ? 'Computer use is allowed for future actions, but approval of this request was not confirmed.' : allowComputer ? 'Computer permission could not be confirmed. This request was not approved; check bot settings before retrying.' : 'The decision could not be confirmed. Inspect the request state before retrying.';
      approvalFeedback.set(botId, { createdAt: new Date().toISOString(), runId: approval.runId, error: true, text: `${explanation} ${errorText(error)} Nothing was retried automatically.` });
    } finally {
      if (session === authSession && approvalWork.get(key) === work) {
        work.busy = false;
        if (selected?.id === botId) { renderApprovals(); queueComputerStatus(); void guarded(() => Promise.all([loadApprovals(), loadRuns()])); }
      }
    }
  }
  function renderApprovals() { renderMessages(); }
  async function loadApprovals(version = generation) {
    const id = selected?.id, sequence = ++approvalsRequest; if (!id) return; const result = await request(`${botPath(id)}/approvals`); if (!validView(version) || sequence !== approvalsRequest) return;
    approvals = result.approvals; renderApprovals();
  }
  function scheduleRefresh(version) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (validView(version)) void guarded(() => Promise.all([loadMessages(version), loadRuns(version), loadApprovals(version)])); }, 300); }
  function redact(value, key = '') {
    if (/token|secret|password|authorization|credential/i.test(key)) return '[hidden]';
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') { const result = {}; for (const [name, item] of Object.entries(value)) result[name] = value.type === 'type' && name === 'text' ? '[hidden]' : redact(item, name); return result; } return value;
  }
  function renderStreamDraft() { renderMessages(); }
  function recordEvent(event, version) {
    if (!validView(version) || !Number.isSafeInteger(event.id) || event.id <= cursor) return;
    if (['computer.action', 'computer.suspended', 'tool.started', 'tool.completed', 'approval.updated'].includes(event.type)) queueComputerStatus();
    cursor = event.id; events.push(event); if (events.length > 200) events.shift(); $('event-count').textContent = String(events.length);
    const row = el('article', 'event'), title = el('div', 'event-title'); title.append(el('span', '', event.type.replaceAll('.', ' · ')), el('span', 'muted', `#${event.id} · ${time(event.createdAt)}`));
    const detail = el('details'); detail.append(el('summary', '', 'Event details')); const serialized = JSON.stringify(redact(event.data), null, 2); detail.append(el('pre', '', serialized.length > 8000 ? `${serialized.slice(0, 8000)}\n…` : serialized)); row.append(title, detail); $('activity-list').prepend(row); while ($('activity-list').children.length > 200) $('activity-list').lastElementChild.remove();
    if (event.type === 'run.updated' && event.data.run) {
      const run = event.data.run;
      if ((runs.has(run.id) || !boundary || run.createdAt >= boundary) && mergeRun(run, 'event')) { runRevision++; if (!terminal.has(run.status)) activeRunIds.add(run.id); renderRuns(); }
    }
    if (event.type === 'runtime.snapshot' && typeof event.data.partialText === 'string' && activeRunIds.has(event.runId) && !terminal.has(runs.get(event.runId)?.status)) {
      // Recovery snapshots replace the whole partial; only later deltas append.
      if (event.data.busy === false) streamDrafts.delete(event.runId); else streamDrafts.set(event.runId, event.data.partialText);
      renderStreamDraft();
    }
    if (event.type === 'message.delta' && typeof event.data.delta === 'string') {
      if (activeRunIds.has(event.runId) && !terminal.has(runs.get(event.runId)?.status)) { streamDrafts.set(event.runId, (streamDrafts.get(event.runId) || '') + event.data.delta); renderStreamDraft(); }
      return;
    }
    if ((event.type === 'message.created' && event.data.message?.role === 'assistant') || (event.type === 'message' && event.data.role === 'assistant')) { streamDrafts.delete(event.runId); renderStreamDraft(); }
    scheduleRefresh(version);
  }
  const pause = (ms, signal) => new Promise((resolve) => { if (signal.aborted) return resolve(); const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); });
  function startStream() { streamController?.abort(); if (!selected || !token) return; streamController = new AbortController(); void streamEvents(selected.id, generation, streamController.signal); }
  async function streamEvents(id, version, signal) {
    let delay = 1000;
    while (!signal.aborted && validView(version)) {
      $('stream-state').textContent = cursor ? 'Reconnecting…' : 'Connecting…';
      try {
        const response = await request(`${botPath(id)}/events?after=${cursor}`, { signal, raw: true }); if (!response.body) throw new Error('Streaming unavailable.');
        if (signal.aborted || !validView(version)) { await response.body.cancel().catch(() => {}); return; }
        $('stream-state').textContent = '● Live'; $('reconnect-stream').hidden = true; delay = 1000;
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', dataLines = [];
        try { while (!signal.aborted) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let index; while ((index = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1); if (!line) { if (dataLines.length) { try { recordEvent(JSON.parse(dataLines.join('\n')), version); } catch { /* Ignore malformed non-product events. */ } dataLines = []; } } else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, '')); } } }
        finally { await reader.cancel().catch(() => {}); }
      } catch { if (signal.aborted || !validView(version)) return; $('stream-state').textContent = 'Updates paused'; $('reconnect-stream').hidden = false; }
      await pause(delay, signal); delay = Math.min(delay * 2, 15000);
    }
  }
  function renderProgress() {
    const pending = selected && computerPending.get(selected.id); $('computer-progress').hidden = !pending;
    for (const control of document.querySelectorAll('[data-computer]')) control.disabled = Boolean(pending);
    $('click-mode').disabled = Boolean(pending); $('auto-screenshot').disabled = Boolean(pending);
    if (pending) { const seconds = Math.floor((Date.now() - pending.started) / 1000); $('computer-progress-label').textContent = pending.label; $('computer-elapsed').textContent = `${seconds}s`; $('computer-cold-hint').hidden = seconds < 10; }
    if (!computerPending.size) { clearInterval(progressTimer); progressTimer = null; }
  }
  function beginComputer(id, label) { if (computerPending.has(id)) return null; const pending = { started: Date.now(), label }; computerPending.set(id, pending); if (!progressTimer) progressTimer = setInterval(renderProgress, 500); renderProgress(); $('computer-warning').hidden = true; return pending; }
  function finishComputer(id, pending) { if (computerPending.get(id) === pending) computerPending.delete(id); renderProgress(); }
  function warning(message) { $('computer-warning').textContent = message; $('computer-warning').hidden = false; }
  function stopComputerStatus() { clearTimeout(computerStatusTimer); computerStatusTimer = null; computerStatusRequest++; }
  function queueComputerStatus() { if (!selected || !token || $('panel-computer').hidden) return; clearTimeout(computerStatusTimer); computerStatusTimer = setTimeout(() => { computerStatusTimer = null; void guarded(computerStatus); }, 250); }
  async function computerStatus() {
    const version = generation, id = selected?.id; if (!id || !token || $('panel-computer').hidden) return;
    clearTimeout(computerStatusTimer); computerStatusTimer = null; const sequence = ++computerStatusRequest;
    try {
      const { computer } = await request(`${botPath(id)}/computer`);
      if (!validView(version) || sequence !== computerStatusRequest || $('panel-computer').hidden) return;
      const diagnostic = computer.error?.message ? `${computer.error.message}${computer.error.code ? ` (${computer.error.code})` : ''}` : computer.state === 'unavailable' ? 'Computer health could not be confirmed. Refresh status to check again.' : '';
      $('computer-status').textContent = `${statusLabel(computer.state)} · ${computer.provider}${computer.lastCheckpointId ? ' · checkpoint available' : ''}${diagnostic ? ` · ${diagnostic}` : ''}`;
      if (computer.state === 'starting') computerStatusTimer = setTimeout(() => { computerStatusTimer = null; void guarded(computerStatus); }, 1500);
    } catch (error) { if (!validView(version) || sequence !== computerStatusRequest || $('panel-computer').hidden) return; $('computer-status').textContent = 'Status could not be refreshed. Check your connection and refresh status.'; throw error; }
  }
  function renderResult(result, action) {
    $('result-details').hidden = false; $('result-raw').textContent = JSON.stringify(redact(result), null, 2);
    const parts = [];
    if (action.type === 'listFiles' && result.status === 'completed') parts.push(`Directory: /workspace${action.path && action.path !== '.' ? `/${action.path}` : ''}`);
    else if (result.output) parts.push(result.output);
    if (result.exitCode !== undefined) parts.push(`Exit code: ${result.exitCode}`);
    if (!parts.length) parts.push(result.status === 'completed' ? `${action.type === 'screenshot' ? 'Screenshot captured' : 'Action completed'}.` : `Action ${result.status}.`);
    if (result.checkpointId) parts.push('Workspace checkpoint confirmed.');
    if (result.error) parts.push(result.error);
    $('computer-result').textContent = parts.join('\n\n');
    if (result.status === 'completed' && result.error) warning(`Action completed with a warning: ${result.error}`);
    if (action.type === 'checkpoint' && result.status === 'completed' && !result.checkpointId) warning('No checkpoint reference was returned. Durable storage is not confirmed.');
  }
  function renderFiles(output, path) {
    let entries; try { entries = JSON.parse(output); } catch { return; } if (!Array.isArray(entries)) return;
    directoryPath = path || '.'; $('file-list').replaceChildren();
    if (!entries.length) $('file-list').append(el('p', 'hint', 'This folder is empty.'));
    for (const entry of entries) {
      if (typeof entry.name !== 'string' || entry.name.includes('/') || ['.', '..'].includes(entry.name)) continue;
      const button = el('button', 'file-entry'); button.type = 'button'; button.dataset.fileName = entry.name; button.dataset.fileKind = entry.kind; button.dataset.computer = '';
      button.append(el('span', 'file-icon', entry.kind === 'directory' ? '▱' : entry.kind === 'symlink' ? '↗' : '≡'), el('span', '', entry.name));
      button.addEventListener('click', () => guarded(async () => { const relative = directoryPath === '.' ? entry.name : `${directoryPath}/${entry.name}`; $('file-path').value = relative; await computerAction({ type: entry.kind === 'directory' ? 'listFiles' : 'readFile', path: relative }); })); $('file-list').append(button);
    }
    renderProgress();
  }
  async function showArtifact(result, id, version) {
    if (!result.artifactId || !validView(version)) return; artifact = { id: result.artifactId, botId: id }; $('download-artifact').hidden = false;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType)) return;
    const response = await request(`${botPath(id)}/artifacts/${encodeURIComponent(result.artifactId)}`, { raw: true }); const blob = await response.blob(); if (!validView(version)) return;
    if (screenUrl) URL.revokeObjectURL(screenUrl); screenUrl = URL.createObjectURL(blob); $('screenshot').src = screenUrl; $('screenshot').hidden = false; $('screen-placeholder').hidden = true; $('screenshot-time').textContent = `Screenshot updated ${time(new Date().toISOString())}`;
  }
  async function executeAction(id, action) {
    const key = `${id}:${JSON.stringify(action)}`, operationId = pendingActions.get(key) || crypto.randomUUID(); pendingActions.set(key, operationId);
    const { result } = await request(`${botPath(id)}/computer/actions`, { method: 'POST', body: { operationId, action } }); pendingActions.delete(key); return result;
  }
  async function computerAction(action) {
    if (!selected) return; const id = selected.id, version = generation, refreshScreen = guiActions.has(action.type) && $('auto-screenshot').checked && Boolean(screenUrl);
    const labels = { exec: 'Running command', screenshot: 'Taking screenshot', readFile: 'Reading file', writeFile: 'Writing file', listFiles: 'Loading folder', checkpoint: 'Saving checkpoint', navigate: 'Opening browser URL', type: 'Typing text', click: 'Clicking screen', key: 'Pressing key', scroll: 'Scrolling' };
    const pending = beginComputer(id, labels[action.type] || 'Working'); if (!pending) return;
    try {
      const result = await executeAction(id, action); if (!validView(version)) return; renderResult(result, action);
      if (result.status !== 'completed') throw new Error(result.error || `Action ${result.status}. It was not retried.`);
      if (action.type === 'readFile') $('file-content').value = result.output || '';
      if (action.type === 'listFiles') renderFiles(result.output || '', action.path || '.');
      await showArtifact(result, id, version);
      if (!validView(version)) return;
      if (refreshScreen && validView(version)) { computerPending.get(id).label = 'Refreshing screenshot'; renderProgress(); const image = await executeAction(id, { type: 'screenshot' }); if (!validView(version)) return; if (image.status === 'completed') { await showArtifact(image, id, version); if (image.error && validView(version)) warning(`The action completed. Screenshot warning: ${image.error}`); } else warning('The action completed, but the screenshot could not be refreshed.'); }
      if (validView(version)) await computerStatus();
    } catch (error) { if (validView(version)) { if (!$('result-details').hidden) warning(errorText(error)); else $('computer-result').textContent = errorText(error); throw error; } }
    finally { finishComputer(id, pending); }
  }
  async function suspendComputer() {
    if (!selected) return; const id = selected.id, version = generation, pending = beginComputer(id, 'Saving workspace and suspending computer'); if (!pending) return;
    try { const { computer } = await request(`${botPath(id)}/computer/suspend`, { method: 'POST', body: {} }); if (!validView(version)) return; clearScreen(); renderResult({ status: 'completed', ...(computer.lastCheckpointId ? { checkpointId: computer.lastCheckpointId } : {}), output: 'Computer suspended. The next action restores its workspace.' }, { type: 'suspend' }); if (!computer.lastCheckpointId) warning('No checkpoint reference was returned. Durable storage is not confirmed.'); await computerStatus(); }
    finally { finishComputer(id, pending); }
  }
  function renderChatGPT(status) {
    chatGPTConnected = status.connected === true; const account = status.account ? `${status.account.clientId}:${status.account.subject}` : null;
    if (account !== chatGPTAccount || !chatGPTConnected) $('chatgpt-verification').textContent = 'Model access has not been verified.'; chatGPTAccount = account;
    if (chatGPTConnected && status.status === 'verified' && Number.isFinite(Date.parse(status.verifiedAt))) $('chatgpt-verification').textContent = `gpt-6.1-sol last verified ${new Date(status.verifiedAt).toLocaleString()}.`;
    $('chatgpt-status').textContent = chatGPTConnected ? 'Connected to your ChatGPT account.' : 'Not connected. Run the local login command.'; $('chatgpt-account').textContent = status.account?.email || ''; $('chatgpt-account').hidden = !status.account?.email;
    $('verify-chatgpt').disabled = chatGPTBusy || !chatGPTConnected; $('disconnect-chatgpt').hidden = !chatGPTConnected; document.querySelector('.setup-details').open = !chatGPTConnected;
  }
  async function chatGPTTask(task) {
    if (chatGPTBusy) return; const session = authSession; chatGPTBusy = true; $('chatgpt-error').textContent = ''; for (const id of ['refresh-chatgpt', 'verify-chatgpt', 'disconnect-chatgpt']) $(id).disabled = true;
    try { await task(session); } catch (error) { if (session === authSession) $('chatgpt-error').textContent = errorText(error); }
    finally { if (session === authSession) { chatGPTBusy = false; $('refresh-chatgpt').disabled = false; $('disconnect-chatgpt').disabled = false; $('verify-chatgpt').disabled = !chatGPTConnected; } }
  }
  async function loadChatGPT(session = authSession) { const status = await request('/v1/connections/chatgpt'); if (session === authSession) renderChatGPT(status); }
  function showPanel(name, focus = false) {
    for (const button of document.querySelectorAll('[data-panel]')) { const active = button.dataset.panel === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; $(`panel-${button.dataset.panel}`).hidden = !active; if (active && focus) button.focus(); }
    if (name !== 'computer') stopComputerStatus();
    if (name === 'computer' && selected) void guarded(computerStatus); if (name === 'runs' && selected) void guarded(() => loadRuns());
  }
  function bindForm(id, fn) { $(id).addEventListener('submit', (event) => { event.preventDefault(); void guarded(fn); }); }
  function openCreate() { $('create-error').textContent = ''; $('bot-dialog').showModal(); $('bot-name').focus(); }
  for (const id of ['new-bot', 'empty-new-bot']) $(id).addEventListener('click', openCreate);
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  $('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter || event.currentTarget.querySelector('[type=submit]'); button.disabled = true; $('login-error').textContent = ''; authSession++; sessionController = new AbortController(); token = $('token').value.trim();
    try { await loadBots(); $('token').value = ''; $('login').hidden = true; $('app').hidden = false; $('disconnect').hidden = false; $('settings-button').hidden = false; $('connection').textContent = 'Cloud connected'; $('empty').hidden = false; $('bot-workspace').hidden = true; void chatGPTTask(loadChatGPT); const bot = bots.find((item) => item.id === chosenHash()) || bots[0]; if (bot) await guarded(() => selectBot(bot)); }
    catch (error) { if (token) { disconnect(); $('login-error').textContent = errorText(error); } }
    finally { button.disabled = false; }
  });
  $('disconnect').addEventListener('click', () => disconnect()); $('bot-search').addEventListener('input', renderBots); $('reload-bots').addEventListener('click', () => guarded(loadBots));
  window.addEventListener('hashchange', () => { const bot = bots.find((item) => item.id === chosenHash()); if (bot) void guarded(() => selectBot(bot)); });
  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter || event.currentTarget.querySelector('[type=submit]'); button.disabled = true; $('create-error').textContent = '';
    try { const { bot } = await request('/v1/bots', { method: 'POST', body: { name: $('bot-name').value.trim(), instructions: $('bot-instructions').value.trim(), model: $('bot-model').value, computerApprovalMode: $('bot-computer-approval-mode').value } }); $('create-form').reset(); $('bot-dialog').close(); $('bot-search').value = ''; bots = [bot, ...bots.filter((item) => item.id !== bot.id)]; renderBots(); await guarded(() => selectBot(bot)); }
    catch (error) { if (token) $('create-error').textContent = errorText(error); } finally { button.disabled = false; }
  });
  $('edit-bot').addEventListener('click', () => { if (!selected) return; editBotId = selected.id; $('edit-name').value = selected.name; $('edit-instructions').value = selected.instructions; $('edit-computer-approval-mode').value = selected.computerApprovalMode === 'automatic' ? 'automatic' : 'ask'; $('edit-error').textContent = ''; $('edit-dialog').showModal(); $('edit-name').focus(); });
  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter || event.currentTarget.querySelector('[type=submit]'), id = editBotId; if (!id) return; button.disabled = true; $('edit-error').textContent = '';
    try { const { bot } = await request(botPath(id), { method: 'PATCH', body: { name: $('edit-name').value.trim(), instructions: $('edit-instructions').value.trim(), computerApprovalMode: $('edit-computer-approval-mode').value } }); bots = bots.map((item) => item.id === bot.id ? bot : item); if (selected?.id === bot.id) { selected = bot; updateBotHeader(); renderMessages(); renderApprovals(); } renderBots(); $('edit-dialog').close(); }
    catch (error) { if (token) $('edit-error').textContent = errorText(error); } finally { button.disabled = false; }
  });
  $('cancel-run').addEventListener('click', () => { if (currentRun) void guarded(() => cancelRun(currentRun.id)); });
  $('refresh-runs').addEventListener('click', () => guarded(() => loadRuns())); $('load-more-runs').addEventListener('click', () => guarded(() => loadRuns(generation, true)));
  $('approval-shortcut').addEventListener('click', () => { runFilter = null; focusApproval++; showPanel('conversation'); renderMessages(); });
  const tabs = [...document.querySelectorAll('[data-panel]')];
  tabs.forEach((button, index) => { button.addEventListener('click', () => showPanel(button.dataset.panel)); button.addEventListener('keydown', (event) => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); showPanel(tabs[next].dataset.panel, true); } }); });
  $('refresh-history').addEventListener('click', () => guarded(() => Promise.all([loadMessages(), loadRuns(), loadApprovals()]))); $('reconnect-stream').addEventListener('click', startStream);
  $('refresh-computer').addEventListener('click', () => guarded(computerStatus)); $('take-screenshot').addEventListener('click', () => guarded(() => computerAction({ type: 'screenshot' })));
  $('checkpoint').addEventListener('click', () => guarded(() => computerAction({ type: 'checkpoint' }))); $('suspend-computer').addEventListener('click', () => guarded(suspendComputer));
  $('click-mode').addEventListener('change', () => document.querySelector('.screen').classList.toggle('click-enabled', $('click-mode').checked));
  $('screenshot').addEventListener('click', (event) => { const image = $('screenshot'); if (!$('click-mode').checked || computerPending.has(selected?.id) || !image.naturalWidth || !image.naturalHeight) return; const rect = image.getBoundingClientRect(); const x = Math.max(0, Math.min(image.naturalWidth - 1, Math.floor((event.clientX - rect.left) / rect.width * image.naturalWidth))), y = Math.max(0, Math.min(image.naturalHeight - 1, Math.floor((event.clientY - rect.top) / rect.height * image.naturalHeight))); $('click-x').value = String(x); $('click-y').value = String(y); void guarded(() => computerAction({ type: 'click', x, y, button: 'left' })); });
  bindForm('navigate-form', () => computerAction({ type: 'navigate', url: $('navigate-url').value }));
  bindForm('click-form', () => computerAction({ type: 'click', x: Number($('click-x').value), y: Number($('click-y').value), button: $('click-button').value }));
  bindForm('type-form', async () => { const text = $('type-text').value; $('type-text').value = ''; await computerAction({ type: 'type', text }); }); bindForm('key-form', () => computerAction({ type: 'key', key: $('key-name').value }));
  for (const direction of ['up', 'down']) $(`scroll-${direction}`).addEventListener('click', () => guarded(() => computerAction({ type: 'scroll', direction, amount: 3 })));
  bindForm('exec-form', () => computerAction({ type: 'exec', command: $('exec-command').value, timeoutMs: 30000 }));
  $('list-files').addEventListener('click', () => guarded(() => computerAction({ type: 'listFiles', path: $('file-path').value || '.' })));
  $('read-file').addEventListener('click', () => guarded(() => computerAction({ type: 'readFile', path: $('file-path').value })));
  $('write-file').addEventListener('click', () => guarded(() => computerAction({ type: 'writeFile', path: $('file-path').value, content: $('file-content').value })));
  $('file-up').addEventListener('click', () => guarded(() => { const parent = directoryPath.split('/').slice(0, -1).join('/') || '.'; $('file-path').value = parent; return computerAction({ type: 'listFiles', path: parent }); }));
  $('clear-result').addEventListener('click', () => { $('computer-result').textContent = 'No actions yet.'; $('result-raw').textContent = ''; $('result-details').hidden = true; $('computer-warning').hidden = true; $('download-artifact').hidden = true; artifact = null; });
  $('download-artifact').addEventListener('click', () => guarded(async () => { if (!artifact) return; const { id, botId } = artifact, response = await request(`${botPath(botId)}/artifacts/${encodeURIComponent(id)}`, { raw: true }); const url = URL.createObjectURL(await response.blob()), anchor = el('a'); anchor.href = url; anchor.download = `artifact-${id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }));
  $('settings-button').addEventListener('click', () => { $('settings-dialog').showModal(); void chatGPTTask(loadChatGPT); }); $('refresh-chatgpt').addEventListener('click', () => chatGPTTask(loadChatGPT));
  $('copy-chatgpt-login').addEventListener('click', async () => { try { await navigator.clipboard.writeText('npm run chatgpt:login'); $('chatgpt-verification').textContent = 'Login command copied. Run it in your local Timber checkout.'; } catch { $('chatgpt-error').textContent = 'Copy the command above and run it in your local Timber checkout.'; } });
  $('verify-chatgpt').addEventListener('click', () => chatGPTTask(async (session) => { $('chatgpt-verification').textContent = 'Testing gpt-6.1-sol with one small real request…'; try { const result = await request('/v1/connections/chatgpt/verify', { method: 'POST', body: {} }); if (session !== authSession) return; if (result.ok !== true || result.model !== 'gpt-6.1-sol') throw new Error('The backend did not confirm gpt-6.1-sol access.'); $('chatgpt-verification').textContent = 'Verified: gpt-6.1-sol completed a real request.'; } catch (error) { if (session === authSession) $('chatgpt-verification').textContent = 'Model access was not verified.'; throw error; } }));
  $('disconnect-chatgpt').addEventListener('click', () => chatGPTTask(async (session) => { const status = await request('/v1/connections/chatgpt', { method: 'DELETE' }); if (session !== authSession) return; renderChatGPT(status); $('chatgpt-verification').textContent = status.revoked === true ? 'ChatGPT disconnected and its renewable session revoked.' : 'Cloud credentials removed. Remote revocation was not confirmed; disconnect Timber in ChatGPT Settings.'; }));
  window.addEventListener('pagehide', () => disconnect());
})();
