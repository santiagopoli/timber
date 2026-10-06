import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN, BOT_A, BOT_B} from './console-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
});
after(async () => {await browser?.close();});
async function withPage(work, options = {}) {
  const fixture = await createConsoleFixture();
  const context = await browser.newContext({viewport: {width: 1440, height: 1050}, colorScheme: 'light', ...options});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  const login = async () => {await page.goto(fixture.url); await page.locator('#token').fill(TEST_TOKEN); await page.locator('#connect-form button').click(); await page.locator('#bot-workspace').waitFor({state: 'visible'}); await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});};
  try {await work({...fixture, page, context, login}); assert.deepEqual(errors, [], 'no uncaught browser errors'); assert.deepEqual(fixture.state.failures, [], 'fixture requests completed');}
  finally {await context.close(); await fixture.close();}
}
const until = async (page, id, text) => page.locator(id).filter({hasText: text}).waitFor();

test('bot administration, isolated drafts, safe message rendering and session clearing', async () => {
  await withPage(async ({page, login, state}) => {
    state.messages.get(BOT_A)[1].text += '\n\n<img src=x onerror=alert(1)>';
    await login();
    await until(page, '#selected-name', 'Ada');
    assert.equal(await page.locator('#messages img').count(), 0, 'model text cannot inject HTML');
    assert.equal(await page.locator('#messages strong').innerText(), 'Three themes');
    assert.match(await page.locator('#messages pre').innerText(), /cat notes/);
    await page.locator('#message').fill('Draft only for Ada');
    await page.locator('#bot-search').fill('Linus'); assert.equal(await page.locator('.bot-item').count(), 1);
    await page.locator(`[data-bot-id="${BOT_B}"]`).click(); await until(page, '#selected-name', 'Linus'); assert.equal(await page.locator('#message').inputValue(), '');
    await page.locator('#message').fill('Draft only for Linus'); await page.locator('#bot-search').fill('');
    await page.locator(`[data-bot-id="${BOT_A}"]`).click(); await until(page, '#selected-name', 'Ada'); assert.equal(await page.locator('#message').inputValue(), 'Draft only for Ada');
    await page.locator('#edit-bot').click(); await page.locator('#edit-name').fill('Ada research'); await page.locator('#edit-instructions').fill('Keep concise research notes.'); await page.locator('#edit-form [type=submit]').click(); await until(page, '#selected-name', 'Ada research');
    assert.equal(state.bots[0].instructions, 'Keep concise research notes.');
    await page.locator('#new-bot').click(); await page.locator('#bot-name').fill('Grace'); await page.locator('#bot-instructions').fill('Review software.'); await page.locator('#create-form [type=submit]').click(); await until(page, '#selected-name', 'Grace');
    assert.equal(state.bots[0].name, 'Grace'); assert.match(page.url(), /#bot=/);
    const storage = await page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}})); assert.equal(JSON.stringify(storage).includes(TEST_TOKEN), false);
    await page.locator('#disconnect').click(); await page.locator('#login').waitFor({state: 'visible'}); assert.equal(await page.locator('#token').inputValue(), ''); assert.equal(await page.locator('#messages').innerText(), '');
    await login(); assert.equal(await page.locator('#message').inputValue(), '', 'drafts removed on disconnect');
    await page.reload(); await page.locator('#login').waitFor({state: 'visible'}); assert.equal(await page.locator('#app').isVisible(), false);
  });
});

test('computer permission defaults to ask and persists explicit create/edit settings without approving stored actions', async () => {
  await withPage(async ({page, login, state}) => {
    const previousApprovals = ['pending', 'denied', 'interrupted'].map((status, i) => ({
      id: `existing-approval-${i}`, botId: BOT_A, runId: 'existing-run', operationId: `existing-operation-${i}`,
      status, action: {type: 'exec', command: 'printf existing-action'}, createdAt: '2026-10-05T10:00:00Z', expiresAt: '2026-10-07T10:00:00Z',
      ...(status === 'interrupted' ? {result: {operationId: `existing-operation-${i}`, status, error: 'Inspect existing effects.'}} : {}),
    }));
    state.approvals.set(BOT_A, structuredClone(previousApprovals));
    assert.equal(state.bots[0].computerApprovalMode, undefined, 'fixture includes a legacy bot');
    await login(); await until(page, '#selected-computer-mode', 'Ask for each action');
    await page.locator('#edit-bot').click(); assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'ask');
    assert.match(await page.locator('#edit-computer-approval-help').innerText(), /commands, write files, and control the browser/);
    assert.match(await page.locator('#edit-computer-approval-help').innerText(), /Existing requests stay unchanged/);
    await page.locator('#edit-computer-approval-mode').selectOption('automatic'); await page.locator('#edit-form [type=submit]').click();
    await until(page, '#selected-computer-mode', 'Use authorized');
    assert.equal(state.bots.find(bot => bot.id === BOT_A).computerApprovalMode, 'automatic');
    assert.equal(state.calls.find(call => call.method === 'PATCH').body.computerApprovalMode, 'automatic');
    await page.locator('#disconnect').click(); await login(); await page.locator('#edit-bot').click();
    assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'automatic', 'saved permission survives reconnect');
    await page.locator('#edit-computer-approval-mode').selectOption('ask'); await page.locator('#edit-form [type=submit]').click();
    await until(page, '#selected-computer-mode', 'Ask for each action'); assert.equal(state.bots.find(bot => bot.id === BOT_A).computerApprovalMode, 'ask');
    await page.locator('#new-bot').click(); assert.equal(await page.locator('#bot-computer-approval-mode').inputValue(), 'ask');
    await page.locator('#bot-name').fill('Authorized bot'); await page.locator('#bot-computer-approval-mode').selectOption('automatic');
    await page.locator('#create-form [type=submit]').click(); await until(page, '#selected-name', 'Authorized bot'); await until(page, '#selected-computer-mode', 'Use authorized');
    assert.equal(state.bots[0].computerApprovalMode, 'automatic');
    await page.locator('#edit-bot').click(); assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'automatic'); await page.locator('#edit-dialog [data-close-dialog]').first().click();
    await page.locator('#new-bot').click(); assert.equal(await page.locator('#bot-computer-approval-mode').inputValue(), 'ask', 'each new bot starts with per-action approval');
    await page.locator('#bot-name').fill('Ask bot'); await page.locator('#create-form [type=submit]').click(); await until(page, '#selected-name', 'Ask bot');
    assert.equal(state.bots[0].computerApprovalMode, 'ask');
    assert.deepEqual(state.calls.filter(call => call.method === 'POST' && call.path === '/v1/bots').map(call => call.body.computerApprovalMode), ['automatic', 'ask']);
    assert.deepEqual(state.approvals.get(BOT_A), previousApprovals, 'stored pending, denied and interrupted requests stay unchanged');
    assert.equal(state.calls.some(call => call.method === 'POST' && /\/(?:approvals|computer)\//.test(call.path)), false, 'configuration never approves or executes stored actions');
    assert.equal(state.actions.length, 0);
  });
});

test('restores older active runs, ignores stale SSE and retains pagination through updates', async () => {
  await withPage(async ({page, login, state}) => {
    const now = new Date('2026-10-05T12:00:00Z');
    const history = Array.from({length: 70}, (_, i) => ({id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, botId: BOT_A, operationId: `fixture-${i}`, status: i === 65 ? 'waiting_approval' : 'completed', createdAt: new Date(now - i * 60000).toISOString(), updatedAt: now.toISOString()}));
    state.runs.set(BOT_A, history); state.emit(BOT_A, 'run.updated', {run: {...history[0], status: 'running', updatedAt: '2026-10-05T11:00:00Z'}}, history[0].id);
    state.emit(BOT_A, 'message.delta', {delta: 'stale response must stay hidden'}, history[0].id);
    await login(); await until(page, '#run-status', 'waiting approval'); assert.equal(await page.locator('#streaming-message').isVisible(), false);
    await page.locator('#tab-runs').click(); await page.locator('#load-more-runs').waitFor({state: 'visible'}); await page.locator('#load-more-runs').click();
    await page.locator(`[data-run-id="${history[59].id}"]`).waitFor();
    state.emit(BOT_A, 'run.updated', {run: history[0]}, history[0].id);
    await page.waitForResponse(response => response.url().includes('/runs?limit=30') && !response.url().includes('before'));
    await page.locator('#load-more-runs').click(); await page.locator(`[data-run-id="${history[69].id}"]`).waitFor();
    assert.equal(await page.locator('#run-list .run-card').count(), 70);
    await page.locator(`[data-run-cancel="${history[65].id}"]`).click();
    await page.locator(`[data-run-id="${history[65].id}"] .status`).filter({hasText: 'cancelled'}).waitFor();
    assert.equal(state.runs.get(BOT_A)[65].status, 'cancelled');
  });
});

test('approval navigation works across panels and hides secure typing text', async () => {
  await withPage(async ({page, login, state}) => {
    const approval = {id: '30000000-0000-4000-8000-000000000001', botId: BOT_A, runId: 'pending', status: 'pending', action: {type: 'type', text: 'test-only-sensitive-input'}, expiresAt: new Date(Date.now() + 3600000).toISOString()};
    state.approvals.set(BOT_A, [approval]); await login(); await page.locator('#tab-computer').click(); await page.locator('#approval-shortcut').click();
    assert.equal(await page.locator('#panel-conversation').isVisible(), true); assert.equal((await page.locator('#approvals').innerText()).includes(approval.action.text), false);
    await page.locator('#approvals').getByRole('button', {name: 'Deny', exact: true}).click(); await page.locator('#approval-shortcut').waitFor({state: 'hidden'}); assert.equal(approval.status, 'denied');
  });
});

test('interrupted approval history is collapsed and exposes safe diagnostics without replay controls or effects', async () => {
  await withPage(async ({page, login, state}) => {
    const interrupted = Array.from({length: 8}, (_, i) => ({
      id: `interrupted-approval-${i}`, botId: BOT_A, runId: 'interrupted-run', operationId: `interrupted-operation-${i}`,
      status: 'interrupted', createdAt: new Date(Date.UTC(2026, 9, 5, 10, i)).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      action: i === 7 ? {type: 'type', text: 'test-only-private-typing'} : {type: 'exec', command: 'printf test'},
      result: {operationId: `interrupted-operation-${i}`, status: 'interrupted', error: `Stored interruption ${i}: inspect existing effects. <img src=x onerror=alert(1)>`},
    }));
    state.approvals.set(BOT_A, interrupted); await login();
    const cards = page.locator('#approvals [data-approval-status="interrupted"]');
    assert.equal(await cards.count(), 8, 'all returned interrupted approvals remain accessible');
    assert.equal(await page.locator('#approval-history').evaluate(node => node.open), false);
    await page.locator('#approval-history summary').click();
    assert.equal(await cards.first().getAttribute('data-approval-id'), interrupted[7].id);
    assert.equal(await page.locator(`[data-approval-id="${interrupted[2].id}"]`).count(), 1);
    for (const approval of interrupted) {
      const card = page.locator(`[data-approval-id="${approval.id}"]`), text = await card.innerText();
      assert.ok(text.includes(`Interrupted action · ${approval.action.type}`));
      assert.ok(text.includes(`Operation ID: ${approval.operationId}`));
      assert.ok(text.includes(approval.result.error), 'stored diagnostic is visible as text');
      assert.match(text, /Inspect its effects before retrying/);
      assert.equal(await card.locator('button, a, input, img').count(), 0, 'diagnostic cards are read-only and cannot inject markup');
    }
    assert.equal((await cards.first().innerText()).includes('test-only-private-typing'), false);
    assert.equal(await page.locator('#approval-shortcut').isVisible(), false, 'interrupted actions are not pending decisions');
    await page.locator('#tab-activity').click();
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    await page.locator('#tab-conversation').click(); assert.equal(await cards.count(), 8);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false, 'loading and refreshing diagnostics never retries or decides an action');
    assert.equal(state.actions.length, 0);
  });
});

const pendingApproval = (id = 'current-request', minute = 20) => ({id, botId: BOT_A, runId: 'pending-run', operationId: `operation-${id}`, status: 'pending', action: {type: 'exec', command: `printf ${id}`}, createdAt: new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString()});

test('newest approval stays beside the composer with long history on desktop and mobile', async () => {
  for (const width of [1440, 390]) await withPage(async ({page, login, state}) => {
    state.messages.set(BOT_A, Array.from({length: 80}, (_, i) => ({id: `long-${i}`, botId: BOT_A, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: ${'Long conversation text. '.repeat(15)}`, createdAt: '2026-10-06T10:00:00Z'})));
    state.approvals.set(BOT_A, Array.from({length: 12}, (_, i) => pendingApproval(`older-${i}`, i)));
    await login();
    state.approvals.get(BOT_A).push(pendingApproval()); state.emit(BOT_A, 'approval.created', {approval: pendingApproval()}, 'pending-run');
    await page.locator('#current-approval[data-approval-id="current-request"]').waitFor();
    await page.evaluate(() => {const history = document.querySelector('#messages'); history.scrollTop = history.scrollHeight; document.querySelector('#message-form').scrollIntoView({block: 'end'});});
    assert.equal(await page.locator('#approval-history').evaluate(node => node.open), false);
    assert.equal(await page.locator('#approval-history [data-approval-id]').count(), 12);
    const button = page.locator('#current-approval [data-approval-decision="approve"]'), bounds = await button.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1000, `current approve button stays visible at the composer on ${width}px`);
    assert.match(await page.locator('#current-approval pre').innerText(), /printf current-request/);
    const layout = await page.evaluate(() => ({history: document.querySelector('#messages').getBoundingClientRect().bottom, approval: document.querySelector('#current-approval').getBoundingClientRect().top, composer: document.querySelector('#message-form').getBoundingClientRect().top}));
    assert.ok(layout.approval >= layout.history && layout.composer > layout.approval);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/approval-${width}.png`});}
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false);
  }, {viewport: {width, height: 1000}});
});

test('combined approval patches then approves once despite refreshes and bot switches', async () => {
  await withPage(async ({page, login, state}) => {
    const approval = pendingApproval(); state.approvals.set(BOT_A, [approval]); await login();
    let release; state.patchGate = new Promise(resolve => {release = resolve;});
    const patch = page.waitForRequest(request => request.method() === 'PATCH');
    await page.locator('[data-approval-decision="approve-and-allow"]').click(); await patch;
    await page.locator('#tab-activity').click();
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    await page.locator('#tab-conversation').click();
    assert.equal(await page.locator('#current-approval button:disabled').count(), 3, 'rerender retains all disabled decision controls');
    await page.locator('[data-approval-decision="approve-and-allow"]').dispatchEvent('click');
    await page.locator(`[data-bot-id="${BOT_B}"]`).click(); await until(page, '#selected-name', 'Linus');
    const approved = page.waitForResponse(response => response.url().endsWith(`/approvals/${approval.id}`)); release(); await approved;
    await page.locator(`[data-bot-id="${BOT_A}"]`).click(); await until(page, '#selected-computer-mode', 'Use authorized');
    await page.locator('#current-approval').waitFor({state: 'detached'});
    assert.deepEqual(state.calls.filter(call => ['POST', 'PATCH'].includes(call.method)).map(({path, method, body}) => ({path, method, body})), [
      {path: `/v1/bots/${BOT_A}`, method: 'PATCH', body: {computerApprovalMode: 'automatic'}},
      {path: `/v1/bots/${BOT_A}/approvals/${approval.id}`, method: 'POST', body: {decision: 'approve'}},
    ]);
    assert.equal(state.bots.find(bot => bot.id === BOT_B).computerApprovalMode, undefined); assert.equal(state.actions.length, 0);
  });
});

test('combined approval handles failed permission updates and expired or unconfirmed approvals without retries', async () => {
  for (const failure of ['patch-http', 'patch-network', 'approval-expired', 'approval-network']) await withPage(async ({page, login, state}) => {
    const approval = pendingApproval(); state.approvals.set(BOT_A, [approval]);
    if (failure === 'patch-http') state.patchError = {code: 'unavailable', message: 'Permission update unavailable.', status: 503};
    if (failure === 'patch-network') await page.route(`**/v1/bots/${BOT_A}`, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    if (failure === 'approval-expired') state.approvalError = {code: 'approval_expired', message: 'This approval expired.', status: 409};
    if (failure === 'approval-network') await page.route(`**/approvals/${approval.id}`, route => route.abort('failed'));
    await login(); await page.locator('[data-approval-decision="approve-and-allow"]').click();
    await until(page, '#approval-feedback', 'Nothing was retried automatically.');
    const feedback = await page.locator('#approval-feedback').innerText();
    if (failure.startsWith('patch')) {assert.match(feedback, /This request was not approved/); assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);}
    else {assert.match(feedback, /Computer use is allowed for future actions, but approval of this request was not confirmed/); assert.equal(state.bots[0].computerApprovalMode, 'automatic'); assert.equal(await page.locator('[data-approval-decision="approve-and-allow"]').count(), 0);}
    if (failure === 'approval-expired') assert.match(feedback, /This approval expired/);
    await page.locator('#tab-activity').click(); await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    assert.equal(state.calls.filter(call => call.method === 'PATCH').length, failure === 'patch-network' ? 0 : 1);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, failure === 'approval-expired' ? 1 : 0);
    assert.equal(approval.status, 'pending'); assert.equal(state.actions.length, 0);
  });
});

test('logout stops the combined action before its approval follow-up', async () => {
  await withPage(async ({page, login, state}) => {
    state.approvals.set(BOT_A, [pendingApproval()]); await login(); let release; state.patchGate = new Promise(resolve => {release = resolve;});
    const patch = page.waitForRequest(request => request.method() === 'PATCH'); await page.locator('[data-approval-decision="approve-and-allow"]').click(); await patch;
    await page.locator('#disconnect').click(); release(); await page.locator('#login').waitFor({state: 'visible'});
    await login(); assert.equal(await page.locator('[data-approval-decision="approve-and-allow"]').count(), 0, 'saved mode is reflected after reconnect');
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 0); assert.equal(state.actions.length, 0);
  });
});

test('expired requests stay read-only and fresh terminal state replaces a cached executing approval', async () => {
  await withPage(async ({page, login, state}) => {
    const pending = pendingApproval(), expired = {...pendingApproval('expired-request', 30), expiresAt: '2020-01-01T00:00:00Z'};
    state.bots[0].computerApprovalMode = 'automatic'; state.approvals.set(BOT_A, [expired, pending]); state.approvalStatus = 'executing';
    await login(); assert.equal(await page.locator('#current-approval').getAttribute('data-approval-id'), pending.id);
    assert.equal(await page.locator('[data-approval-decision="approve-and-allow"]').count(), 0);
    await page.locator('#approval-history summary').click();
    assert.equal(await page.locator('[data-approval-status="expired"] button').count(), 0);
    assert.match(await page.locator('[data-approval-status="expired"]').innerText(), /can no longer be approved/);
    await page.locator('#current-approval [data-approval-decision="approve"]').click(); await until(page, '#current-approval', 'Approved action is executing');
    pending.status = 'completed'; state.emit(BOT_A, 'approval.updated', {approval: pending}, pending.runId);
    await page.locator('#current-approval').waitFor({state: 'detached'});
    assert.equal(state.calls.filter(call => call.method === 'PATCH').length, 0);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 1); assert.equal(state.actions.length, 0);
  });
});

test('computer status polls only while starting and visible, refreshes on events, and isolates late responses', async () => {
  await withPage(async ({page, login, state}) => {
    await page.clock.install(); state.computerStates.set(BOT_A, {state: 'starting'}); await login();
    await page.locator('#tab-computer').click(); await until(page, '#computer-status', 'starting');
    const reads = () => state.calls.filter(call => call.path.endsWith('/computer')).length;
    state.computerStates.set(BOT_A, {state: 'running'});
    const ready = page.waitForResponse(response => response.url().endsWith('/computer')); await page.clock.fastForward(1600); await ready;
    await until(page, '#computer-status', 'running'); const settledReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), settledReads);
    state.computerStates.set(BOT_A, {state: 'unavailable', error: {code: 'computer_health_unavailable', message: 'Computer control server did not respond.'}});
    const health = page.waitForResponse(response => response.url().endsWith('/computer')); state.emit(BOT_A, 'computer.action', {}); await page.clock.fastForward(300); await health;
    await until(page, '#computer-status', 'Computer control server did not respond.'); assert.match(await page.locator('#computer-status').innerText(), /computer_health_unavailable/);
    const unavailableReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), unavailableReads);
    state.computerStates.set(BOT_A, {state: 'starting'}); await page.locator('#refresh-computer').click(); await until(page, '#computer-status', 'starting');
    await page.locator('#tab-activity').click(); const hiddenReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), hiddenReads);
    let release; state.computerStatusGate = new Promise(resolve => {release = resolve;});
    const requested = page.waitForRequest(request => request.url().endsWith(`/bots/${BOT_A}/computer`)); await page.locator('#tab-computer').click(); await requested;
    state.computerStatusGate = null; await page.locator(`[data-bot-id="${BOT_B}"]`).click(); await until(page, '#selected-name', 'Linus'); await until(page, '#computer-status', 'running');
    const late = page.waitForResponse(response => response.url().endsWith(`/bots/${BOT_A}/computer`)); release(); await late;
    await page.clock.fastForward(2000); assert.match(await page.locator('#computer-status').innerText(), /^running/);
    const finalReads = reads(); await page.locator('#disconnect').click(); await page.clock.fastForward(5000); assert.equal(reads(), finalReads);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false); assert.equal(state.actions.length, 0);
  });
});

test('computer actions require explicit screen input and preserve responsive progress and file paths', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); await page.locator('#tab-computer').click();
    let release; state.actionGate = new Promise(resolve => {release = resolve;});
    await page.locator('#take-screenshot').click(); await page.locator('#computer-progress').waitFor({state: 'visible'}); assert.equal(await page.locator('#take-screenshot').isDisabled(), true);
    release(); state.actionGate = null; await page.locator('#screenshot').waitFor({state: 'visible'}); await page.locator('#computer-progress').waitFor({state: 'hidden'});
    await page.waitForFunction(() => document.querySelector('#screenshot').naturalWidth === 1280);
    await page.locator('#screenshot').click(); assert.equal(state.actions.filter(item => item.action.type === 'click').length, 0);
    await page.locator('#click-mode').check(); await page.locator('#screenshot').click(); await page.locator('#computer-progress').waitFor({state: 'hidden'});
    const click = state.actions.find(item => item.action.type === 'click').action; assert.ok(Math.abs(click.x - 640) <= 2 && Math.abs(click.y - 400) <= 2, 'rendered image coordinates map to real desktop dimensions');
    assert.equal(state.actions.filter(item => item.action.type === 'screenshot').length, 1, 'no implicit recurring screenshots');
    await page.locator('#auto-screenshot').check(); await page.locator('#screenshot').click(); await page.locator('#computer-progress').waitFor({state: 'hidden'}); assert.equal(state.actions.filter(item => item.action.type === 'screenshot').length, 2);
    await page.locator('#list-files').click(); await page.locator('[data-file-name="notes"]').waitFor(); await page.locator('[data-file-name="notes"]').click(); await page.locator('[data-file-name="summary.md"]').click();
    await page.waitForFunction(() => document.querySelector('#file-content').value === 'Contents of notes/summary.md'); assert.equal(await page.locator('#file-path').inputValue(), 'notes/summary.md');
    await page.locator('#file-up').click(); await page.locator('[data-file-name="notes"]').waitFor(); assert.equal(await page.locator('#file-path').inputValue(), '.');
    await page.locator('#exec-command').fill('pwd'); await page.locator('#exec-form [type=submit]').click(); await until(page, '#computer-result', 'Exit code: 0'); assert.match(await page.locator('#computer-result').innerText(), /Workspace checkpoint confirmed/);
  });
});

test('late responses cannot overwrite the newly selected bot and 401 clears the session', async () => {
  await withPage(async ({page, login, state}) => {
    await login();
    let release; state.readsGate = new Promise(resolve => {release = resolve;});
    await page.locator('#tab-activity').click(); await page.locator('#refresh-history').click();
    state.readsGate = null; await page.locator(`[data-bot-id="${BOT_B}"]`).click(); await until(page, '#selected-name', 'Linus'); release();
    await page.locator('#tab-conversation').click(); await until(page, '#messages', 'What should Linus work on?'); assert.equal((await page.locator('#messages').innerText()).includes('Three themes'), false);
    state.rejectAuth = true; await page.locator('#reload-bots').click(); await page.locator('#login').waitFor({state: 'visible'}); assert.match(await page.locator('#login-error').innerText(), /rejected or expired/); assert.equal(await page.locator('#token').inputValue(), '');
  });
});

test('desktop and mobile panels remain within the viewport in light and dark themes', async () => {
  await withPage(async ({page, login}) => {
    await login();
    for (const [width, colorScheme] of [[1440, 'light'], [390, 'light'], [390, 'dark']]) {
      await page.setViewportSize({width, height: 1000}); await page.emulateMedia({colorScheme});
      for (const panel of ['conversation', 'runs', 'computer', 'activity']) {
        await page.locator(`#tab-${panel}`).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(overflow <= 1, `${panel} overflows viewport by ${overflow}px at ${width}px`);
      }
      if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.locator('#tab-conversation').click(); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/console-${width}-${colorScheme}.png`, fullPage: true});}
    }
  });
});
