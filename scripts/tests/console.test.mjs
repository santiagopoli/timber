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
  const page = await context.newPage(), errors = [], cspViolations = [];
  await page.exposeFunction('__consoleTestCspViolation', violation => cspViolations.push(violation));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    void globalThis.__consoleTestCspViolation({directive: event.effectiveDirective, resource: event.blockedURI});
  }));
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  const login = async ({selectFirstBot = true} = {}) => {
    await page.goto(fixture.url); await page.locator('#login').waitFor({state: 'visible'});
    await page.locator('#token').fill(TEST_TOKEN); await page.locator('#connect-form button').click(); await page.locator('#app').waitFor({state: 'visible'});
    if (!selectFirstBot) return;
    if (page.viewportSize().width <= 760) await page.locator('.bot-item').first().click();
    await page.locator('#bot-workspace').waitFor({state: 'visible'}); await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
  };
  try {await work({...fixture, page, context, login}); assert.deepEqual(errors, [], 'no uncaught browser errors'); assert.deepEqual(cspViolations, [], 'bundled conversation works within the production content security policy'); assert.deepEqual(fixture.state.failures, [], 'fixture requests completed');}
  finally {await context.close(); await fixture.close();}
}
const until = async (page, id, text) => page.locator(id).filter({hasText: text}).waitFor({state: ['#selected-computer-mode', '#run-status'].includes(id) ? 'attached' : 'visible'});
const selectBot = async (page, botId) => {
  if (page.viewportSize().width <= 760 && !await page.locator(`[data-bot-id="${botId}"]`).isVisible()) await page.locator('#mobile-back').click();
  await page.locator(`[data-bot-id="${botId}"]`).click();
};
const openPanel = async (page, panel) => {
  if (!await page.locator(`#tab-${panel}`).isVisible()) await page.locator('#panel-menu > summary').click();
  await page.locator(`#tab-${panel}`).click();
};
const openBotEditor = async page => {
  if (!await page.locator('#edit-bot').isVisible()) await page.locator('#panel-menu > summary').click();
  await page.locator('#edit-bot').click();
};
const signOut = async page => {
  if (!await page.locator('#settings-dialog').isVisible()) {
    if (await page.locator('#settings-button').isVisible()) await page.locator('#settings-button').click();
    else {if (!await page.locator('#mobile-account').isVisible()) await page.locator('#panel-menu > summary').click(); await page.locator('#mobile-account').click();}
  }
  await page.locator('#disconnect').click();
};

const sentMessages = (state, botId) => state.calls.filter(call => call.method === 'POST' && call.path === `/v1/bots/${botId}/messages`);
const sendMessage = page => page.locator('#message-form').getByRole('button', {name: /^Send(?: message)?(?:\s|$)/}).click();
const deletedBots = state => state.calls.filter(call => call.method === 'DELETE' && /^\/v1\/bots\//.test(call.path));
const openDelete = async page => {await openBotEditor(page); await page.locator('#delete-bot').click(); await page.locator('#delete-dialog').waitFor({state: 'visible'});};

test('Enter and Send enqueue follow-up messages without cancelling the active run', async () => {
  await withPage(async ({page, login, state}) => {
    const run = {id: 'active-send-run', botId: BOT_A, operationId: 'active-send-operation', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
    state.runs.set(BOT_A, [run]);
    state.messages.set(BOT_A, [{id: 'active-send-request', botId: BOT_A, runId: run.id, role: 'user', text: 'Continue the current task.', createdAt: run.createdAt}]);
    await login(); await until(page, '#run-status', 'running');
    await page.locator('#message').fill('Follow-up sent with Enter'); await page.locator('#message').press('Enter');
    await page.locator('[data-message-id]').filter({hasText: 'Follow-up sent with Enter'}).waitFor();
    await page.locator('#message').fill('A second follow-up sent with the button'); await sendMessage(page);
    await page.locator('[data-message-id]').filter({hasText: 'A second follow-up sent with the button'}).waitFor();
    assert.deepEqual(sentMessages(state, BOT_A).map(call => call.body.text), ['Follow-up sent with Enter', 'A second follow-up sent with the button']);
    assert.equal(state.calls.filter(call => call.path.endsWith('/cancel')).length, 0);
    assert.equal(run.status, 'running'); assert.equal(state.runs.get(BOT_A).length, 3);
    assert.equal(await page.locator('#message-form').getByRole('button', {name: /stop/i}).count(), 0, 'sending has no adjacent implicit stop control');
    assert.equal(await page.locator('#cancel-run').isVisible(), true, 'explicit named stop remains available');
  });
});

test('explicitly stopping a run reports cancellation in the conversation without retrying', async () => {
  await withPage(async ({page, login, state}) => {
    const run = {id: 'explicit-stop-run', botId: BOT_A, operationId: 'explicit-stop-operation', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
    state.runs.set(BOT_A, [run]);
    state.messages.set(BOT_A, [{id: 'explicit-stop-request', botId: BOT_A, runId: run.id, role: 'user', text: 'Task to stop explicitly.', createdAt: run.createdAt}]);
    state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: 'Working on the request'}, run.id);
    await login(); await until(page, '#streaming-text', 'Working on the request');
    await page.locator('#cancel-run').click();
    await until(page, '[data-message-id="explicit-stop-request"]', /cancelled/i);
    await page.locator('#streaming-message').waitFor({state: 'hidden'});
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(state.calls.filter(call => call.path.endsWith('/cancel')).map(call => ({path: call.path, method: call.method})), [{path: `/v1/bots/${BOT_A}/runs/${run.id}/cancel`, method: 'POST'}]);
    state.emit(BOT_A, 'message.delta', {delta: 'Late text from a cancelled run'}, run.id);
    await openPanel(page, 'activity');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/messages')), page.locator('#refresh-history').click()]);
    await openPanel(page, 'conversation');
    assert.equal(await page.locator('#streaming-message').isVisible(), false);
    assert.equal((await page.locator('#messages').innerText()).includes('Late text from a cancelled run'), false);
    assert.equal(sentMessages(state, BOT_A).length, 0); assert.equal(state.actions.length, 0);
    assert.equal(await page.getByRole('button', {name: 'Retry sending', exact: true}).count(), 0);
  });
});

test('public progress stays visible beside readable tool activity and the final answer survives reload', async () => {
  for (const width of [1440, 390]) await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'activity-final-run', botId: BOT_A, operationId: 'activity-final-operation', status: 'running', createdAt, updatedAt: createdAt};
    const user = {id: 'activity-request', botId: BOT_A, runId: run.id, role: 'user', text: 'Check the workspace and give me the result.', createdAt};
    const legacy = {id: 'activity-unclassified', botId: BOT_A, runId: run.id, role: 'assistant', text: 'Unclassified assistant text remains a normal message.', createdAt};
    const progress = {id: 'activity-progress', botId: BOT_A, runId: run.id, role: 'assistant', kind: 'progress', text: 'Checking the actual computer workspace.', createdAt: new Date(Date.parse(createdAt) - 1000).toISOString()};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [user, legacy, progress]);
    const toolCallId = 'call-activity-exec', operationId = 'pi-tool:activity-task:call-activity-exec';
    state.emit(BOT_A, 'tool.started', {toolCallId, toolName: 'exec', input: {command: 'pwd', timeoutMs: 10000}}, run.id);
    await login();
    const activity = page.locator(`[data-run-activity="${run.id}"]`);
    const publicProgress = page.locator(`[data-progress-message-id="${progress.id}"]`);
    await publicProgress.waitFor({state: 'visible'});
    assert.equal(await publicProgress.evaluate(node => node.closest('[data-run-activity]') === null), true, 'bot commentary remains a visible conversation message');
    assert.equal(await activity.locator('details[open]').count(), 0, 'diagnostics start collapsed');
    assert.match(await activity.locator('summary').innerText(), /pwd[\s\S]*Running[\s\S]*timeout 10s/, 'the current command and parameters need no disclosure');
    assert.equal(await page.locator(`[data-message-id="${legacy.id}"]`).evaluate(node => node.closest('[data-run-activity]') === null), true);
    await activity.locator(`[data-tool-operation-id="${toolCallId}"]`).waitFor();
    assert.equal(await activity.locator('[data-tool-operation-id]').count(), 1);
    assert.equal(await page.locator(`[data-message-id="${user.id}"]`).evaluate((node, runId) => Boolean(node.compareDocumentPosition(document.querySelector(`[data-run-activity="${runId}"]`)) & Node.DOCUMENT_POSITION_FOLLOWING), run.id), true, 'provider timestamp skew cannot move activity before its own request');
    state.emit(BOT_A, 'tool.completed', {operationId, toolCallId, actionType: 'exec', result: {operationId, status: 'completed', output: '/workspace\n', exitCode: 0}}, run.id);
    await activity.locator(`[data-tool-operation-id="${operationId}"][data-tool-status="completed"]`).waitFor();
    // The native callback reports completion too, but represents the same effect.
    state.emit(BOT_A, 'tool.completed', {toolCallId, toolName: 'exec', operationId, status: 'completed'}, run.id);
    await activity.locator('.timber-activity-count').filter({hasText: '1 action'}).waitFor();
    assert.equal(await activity.locator('[data-tool-operation-id]').count(), 1);
    const tool = activity.locator(`[data-tool-operation-id="${operationId}"]`);
    assert.equal((await tool.locator('[data-tool-result-preview]').innerText()).trim(), '/workspace', 'the actual result is visible before details are opened');
    await tool.locator('summary').click();
    assert.equal(await tool.locator('.timber-tool-output pre').textContent(), '/workspace\n');
    assert.equal(await tool.locator('.timber-tool-status').getAttribute('aria-label'), 'Completed · exit 0');
    assert.match(await page.locator('#run-status').innerText(), /running/, 'a completed command does not claim the whole task finished');
    const final = {id: 'activity-final-answer', botId: BOT_A, runId: run.id, role: 'assistant', kind: 'final', text: '**Workspace verified.** The command succeeded in `/workspace`.', createdAt: new Date(Date.now() + 1000).toISOString()};
    state.messages.set(BOT_A, [user, legacy, progress, final]); run.status = 'completed'; run.updatedAt = final.createdAt;
    state.emit(BOT_A, 'message.created', {message: final}, run.id); state.emit(BOT_A, 'run.updated', {run}, run.id);
    const answer = page.locator(`[data-message-id="${final.id}"]`);
    await answer.filter({hasText: 'Workspace verified.'}).waitFor();
    assert.equal(await answer.evaluate(node => node.closest('[data-run-activity]') === null), true, 'final text remains outside activity');
    assert.equal(await answer.getByRole('button', {name: 'Copy message', exact: true}).isVisible(), true);
    assert.equal(await activity.locator('[data-tool-operation-id]').count(), 1);
    assert.equal(await tool.locator('.timber-tool-output pre').textContent(), '/workspace\n', 'the native completion callback preserves the host result');
    assert.equal(await activity.locator(`[data-progress-message-id="${progress.id}"]`).count(), 0);
    assert.equal(await page.locator(`[data-progress-message-id="${progress.id}"]`).count(), 1);
    assert.equal(await activity.locator(`[data-message-id="${final.id}"]`).count(), 0);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await answer.scrollIntoViewIfNeeded(); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/activity-final-${width}.png`, animations: 'disabled'});}
    await page.reload(); await page.locator('#bot-workspace').waitFor({state: 'visible'});
    await page.locator(`[data-progress-message-id="${progress.id}"]`).waitFor({state: 'visible'});
    await page.locator(`[data-message-id="${final.id}"]`).waitFor({state: 'visible'});
    assert.equal(await page.locator(`[data-run-activity="${run.id}"] details[open]`).count(), 0, 'reload keeps diagnostics optional');
    assert.equal((await page.locator(`[data-run-activity="${run.id}"] [data-tool-result-preview]`).innerText()).trim(), '/workspace', 'reloaded actions still expose their result');
    assert.equal(state.calls.some(call => call.method !== 'GET'), false); assert.equal(state.actions.length, 0);
  }, {viewport: {width, height: 1000}});
});

test('a successful command followed by an empty model answer exposes the failure without replaying the command', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'empty-answer-run', botId: BOT_A, operationId: 'empty-answer-operation', status: 'running', createdAt, updatedAt: createdAt};
    const user = {id: 'empty-answer-request', botId: BOT_A, runId: run.id, role: 'user', text: 'Run the command and explain its result.', createdAt};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [user]);
    const operationId = 'pi-tool:empty-answer:exec';
    state.emit(BOT_A, 'tool.completed', {operationId, toolCallId: 'empty-answer-exec', actionType: 'exec', result: {operationId, status: 'completed', output: 'done\n', exitCode: 0}}, run.id);
    await login();
    run.status = 'failed'; run.error = 'The model ended its turn without a visible answer. The completed tools were not repeated.'; run.updatedAt = new Date(Date.now() + 1000).toISOString();
    state.emit(BOT_A, 'run.updated', {run}, run.id);
    await until(page, '[data-message-id="empty-answer-request"]', 'without a visible answer');
    assert.match(await page.locator('[data-message-id="empty-answer-request"]').innerText(), /Failed/);
    const activity = page.locator(`[data-run-activity="${run.id}"]`);
    assert.equal(await activity.locator(`[data-tool-operation-id="${operationId}"][data-tool-status="completed"]`).count(), 1);
    assert.equal(await page.locator('#streaming-message').isVisible(), false); assert.equal(state.messages.get(BOT_A).length, 1, 'no fabricated final response is introduced');
    assert.equal(sentMessages(state, BOT_A).length, 0); assert.equal(state.actions.length, 0);
    assert.equal(await page.getByRole('button', {name: 'Retry sending', exact: true}).count(), 0);
  });
});

test('a historical approval-request tool callback never claims the action completed or is still awaiting a decision', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'historical-request-run', botId: BOT_A, operationId: 'historical-request-operation', status: 'completed', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]);
    state.messages.set(BOT_A, [
      {id: 'historical-request-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Consider running the command.', createdAt},
      {id: 'historical-request-final', botId: BOT_A, runId: run.id, role: 'assistant', kind: 'final', text: 'That command was not executed. The task is closed.', createdAt},
    ]);
    state.emit(BOT_A, 'tool.completed', {toolCallId: 'historical-request-call', toolName: 'exec', status: 'pending_approval'}, run.id);
    await login();
    const activity = page.locator(`[data-run-activity="${run.id}"]`);
    const step = activity.locator('[data-tool-operation-id="historical-request-call"]');
    await step.waitFor(); assert.equal(await step.getAttribute('data-tool-status'), 'pending_approval');
    assert.match(await step.innerText(), /Approval requested/); assert.doesNotMatch(await step.innerText(), /Completed|Awaiting approval/);
    assert.equal(await page.locator('#approval-shortcut').isVisible(), false);
    assert.equal(await page.locator('[data-approval-decision]').count(), 0);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false);
  });
});

test('action rows expose commands, parameters and results without nested disclosures on mobile and desktop', async () => {
  for (const width of [390, 1440]) await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'readable-actions', botId: BOT_A, operationId: 'readable-request', status: 'running', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]);
    state.messages.set(BOT_A, [{id: 'readable-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Animate the scene, check the file and click the desktop.', createdAt}]);
    state.emit(BOT_A, 'tool.started', {toolCallId: 'write-call', toolName: 'write_file'}, run.id);
    state.emit(BOT_A, 'tool.started', {toolCallId: 'write-call', operationId: 'write-operation', actionType: 'writeFile', input: {path: 'blender/animar_escena.py'}}, run.id);
    state.emit(BOT_A, 'tool.completed', {toolCallId: 'write-call', operationId: 'write-operation', actionType: 'writeFile', input: {path: 'blender/animar_escena.py'}, result: {status: 'completed', output: 'Wrote blender/animar_escena.py'}}, run.id);
    state.emit(BOT_A, 'tool.started', {toolCallId: 'exec-call', operationId: 'exec-operation', toolName: 'exec', input: {command: 'python blender/animar_escena.py --frames 24 --output renders/scene.mp4', timeoutMs: 120000}}, run.id);
    state.emit(BOT_A, 'tool.completed', {toolCallId: 'exec-call', operationId: 'exec-operation', actionType: 'exec', result: {status: 'completed', output: 'Rendered 24 frames\nrenders/scene.mp4\n', exitCode: 0}}, run.id);
    state.emit(BOT_A, 'tool.started', {toolCallId: 'click-call', operationId: 'click-operation', actionType: 'click', input: {x: 460, y: 310, button: 'right'}}, run.id);
    await login();
    const group = page.locator(`[data-run-activity="${run.id}"]`), write = group.locator('[data-tool-operation-id="write-operation"]'), exec = group.locator('[data-tool-operation-id="exec-operation"]'), click = group.locator('[data-tool-operation-id="click-operation"]');
    await click.locator('summary').filter({hasText: 'Running'}).waitFor();
    assert.equal(await group.locator('[data-tool-operation-id]').count(), 3, 'native and host start events describe one write');
    assert.equal(await group.locator('details[open]').count(), 0);
    assert.equal(await group.locator('details details').count(), 0, 'each action has one optional disclosure');
    assert.match(await write.locator('summary').innerText(), /Write blender\/animar_escena.py[\s\S]*Wrote blender\/animar_escena.py/);
    assert.equal(await write.locator('.timber-tool-status').getAttribute('aria-label'), 'Completed');
    assert.match(await exec.locator('summary').innerText(), /python blender\/animar_escena.py --frames 24 --output renders\/scene.mp4[\s\S]*timeout 120s[\s\S]*Rendered 24 frames/);
    assert.equal(await exec.locator('.timber-tool-status').getAttribute('aria-label'), 'Completed · exit 0');
    assert.match(await click.locator('summary').innerText(), /Click \(460, 310\)[\s\S]*Running[\s\S]*right button/);
    assert.equal(await group.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'action rows fit the viewport');
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await click.scrollIntoViewIfNeeded(); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/activity-flat-${width}.png`, animations: 'disabled'});}
    state.emit(BOT_A, 'tool.completed', {toolCallId: 'click-call', operationId: 'click-operation', actionType: 'click', result: {status: 'failed', error: 'The desktop is controlled by another session.'}}, run.id);
    await click.locator('summary').filter({hasText: 'The desktop is controlled by another session.'}).waitFor();
    assert.equal(await click.getAttribute('data-tool-status'), 'failed');
    assert.equal(await group.locator('details[open]').count(), 0, 'failure is visible without expanding');
    await exec.locator('summary').click();
    assert.equal(await exec.locator('.timber-tool-output pre').innerText(), 'Rendered 24 frames\nrenders/scene.mp4\n');
    assert.equal(await exec.locator('details').count(), 0);
    assert.equal(state.actions.length, 0);
  }, {viewport: {width, height: 920}, colorScheme: 'dark'});
});

test('Activity updates running actions immediately and retains them through long message streams', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'live-panel-run', botId: BOT_A, operationId: 'live-panel-request', status: 'running', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [{id: 'live-panel-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Run the workspace checks.', createdAt}]);
    await login(); await openPanel(page, 'activity');
    let release; state.readsGate = new Promise(resolve => {release = resolve;});
    try {
      state.emit(BOT_A, 'tool.started', {operationId: 'live-check-one', toolCallId: 'live-one', toolName: 'exec', input: {command: 'npm test -- --run', timeoutMs: 120000}}, run.id);
      state.emit(BOT_A, 'tool.started', {operationId: 'live-check-two', toolCallId: 'live-two', actionType: 'readFile', input: {path: 'package.json'}}, run.id);
      const first = page.locator('#activity-tools [data-activity-tool-operation-id="live-check-one"]'), second = page.locator('#activity-tools [data-activity-tool-operation-id="live-check-two"]');
      await first.locator('summary').filter({hasText: 'npm test -- --run'}).waitFor();
      await second.locator('summary').filter({hasText: 'Read package.json'}).waitFor();
      assert.equal(await first.getAttribute('data-tool-status'), 'running');
      assert.equal(await second.getAttribute('data-tool-status'), 'running');
      for (let index = 0; index < 225; index++) state.emit(BOT_A, 'message.delta', {delta: index === 224 ? 'stream end' : 'working '}, run.id);
      await page.locator('#streaming-text').filter({hasText: 'stream end'}).waitFor({state: 'attached'});
      assert.equal(await first.getAttribute('data-tool-status'), 'running', 'token events cannot evict a still-running action');
      assert.equal(await second.getAttribute('data-tool-status'), 'running');
      state.emit(BOT_A, 'tool.completed', {operationId: 'live-check-one', toolCallId: 'live-one', actionType: 'exec', input: {command: 'npm test -- --run', timeoutMs: 120000}, result: {status: 'completed', output: '42 tests passed', exitCode: 0}}, run.id);
      await first.locator('summary').filter({hasText: '42 tests passed'}).waitFor();
      assert.equal(await first.getAttribute('data-tool-status'), 'completed');
      assert.equal(await second.getAttribute('data-tool-status'), 'running');
      assert.equal(await page.locator('#activity-tools [data-activity-tool-operation-id]').first().getAttribute('data-activity-tool-operation-id'), 'live-check-two', 'the current action stays first');
      await openPanel(page, 'conversation');
      const chatTool = page.locator('[data-tool-operation-id="live-check-one"]');
      await chatTool.locator('summary').filter({hasText: '42 tests passed'}).waitFor();
      assert.match(await chatTool.locator('summary').innerText(), /npm test -- --run/);
      assert.equal(await page.locator('[data-tool-operation-id="live-check-two"]').getAttribute('data-tool-status'), 'running');
      assert.equal(await page.locator('#messages details[open]').count(), 0);
    } finally {release(); state.readsGate = null;}
  }, {viewport: {width: 390, height: 900}, colorScheme: 'dark'});
});

test('activity preserves resolved host tools, hides private inputs, and does not invent missing file paths', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString(), run = {id: 'safe-input-run', botId: BOT_A, operationId: 'safe-input-request', status: 'completed', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [{id: 'safe-input-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Check the action history.', createdAt}]);
    state.emit(BOT_A, 'tool.started', {toolCallId: 'host-call', toolName: 'call_tool'}, run.id);
    state.emit(BOT_A, 'tool.completed', {operationId: 'host-operation', toolCallId: 'host-call', toolName: 'github_clone', input: {repository: 'santiagopoli/timber', path: 'projects/timber', branch: 'main'}, result: {status: 'completed', output: 'Repository cloned'}}, run.id);
    state.emit(BOT_A, 'tool.completed', {operationId: 'host-operation', toolCallId: 'host-call', toolName: 'call_tool', status: 'completed'}, run.id);
    state.emit(BOT_A, 'tool.completed', {operationId: 'typed-operation', toolCallId: 'typed-call', actionType: 'type', input: {characters: 24, text: 'fixture-private-typed-input'}, result: {status: 'completed', output: 'Typed 24 characters'}}, run.id);
    state.emit(BOT_A, 'tool.completed', {operationId: 'historical-write', actionType: 'writeFile', result: {status: 'completed', output: 'Wrote notes.txt'}}, run.id);
    await login();
    const group = page.locator(`[data-run-activity="${run.id}"]`), host = group.locator('[data-tool-operation-id="host-operation"]'), typed = group.locator('[data-tool-operation-id="typed-operation"]'), historical = group.locator('[data-tool-operation-id="historical-write"]');
    await host.locator('summary').filter({hasText: 'Clone santiagopoli/timber'}).waitFor();
    assert.match(await host.locator('summary').innerText(), /path projects\/timber · branch main/);
    assert.match(await typed.locator('summary').innerText(), /24 characters · input hidden/);
    await typed.locator('summary').click();
    assert.doesNotMatch(await typed.innerText(), /fixture-private-typed-input/);
    await typed.getByRole('button', {name: 'Details', exact: true}).click();
    assert.match(await typed.locator('.timber-tool-data').innerText(), /\[hidden\]/);
    assert.equal(await historical.locator('.timber-tool-command').innerText(), 'Write file');
    assert.equal(await historical.locator('[data-tool-result-preview]').innerText(), 'Wrote notes.txt');
    assert.equal(await group.locator('[data-tool-operation-id]').count(), 3);
    assert.equal(state.actions.length, 0);
  });
});

test('formatted activity contains long commands, copies exact source and updates corner status in both views', async () => {
  for (const width of [390, 1440]) await withPage(async ({page, context, login, state, url}) => {
    const createdAt = new Date().toISOString(), run = {id: 'formatted-activity', botId: BOT_A, operationId: 'formatted-request', status: 'running', createdAt, updatedAt: createdAt};
    const command = 'npm install -g bun@1.3.11 > /tmp/bun-install.log 2>&1 && npm install --prefix /tmp/spacetime-node node@22 > /tmp/node-install.log 2>&1 && cd /workspace/spacetime && PATH=/tmp/spacetime-node/node_modules/.bin:$PATH SESSIONCTL_SKIP_BROWSER_POSTINSTALL=1 PUPPETEER_SKIP_DOWNLOAD=1 bun install --frozen-lockfile > /tmp/spacetime-install.log 2>&1; tail -10 /tmp/spacetime-install.log';
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [{id: 'format-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Instalá las dependencias y verificá la app.', createdAt}]);
    state.emit(BOT_A, 'tool.completed', {operationId: 'format-git', toolName: 'exec', input: {command: 'git -C /workspace/spacetime status --short', timeoutMs: 10000}, result: {status: 'completed', output: ' M client/index.html\n M client/src/main.tsx\n M client/vite.config.ts\n', exitCode: 0}}, run.id);
    state.emit(BOT_A, 'tool.started', {operationId: 'format-install', toolName: 'exec', input: {command, timeoutMs: 120000}}, run.id);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
    await login();
    const row = page.locator('[data-tool-operation-id="format-install"]'), git = page.locator('[data-tool-operation-id="format-git"]');
    await row.waitFor();
    assert.equal(await row.locator('.timber-tool-kind').getAttribute('aria-label'), 'Packages');
    assert.equal(await git.locator('.timber-tool-kind').getAttribute('aria-label'), 'Git');
    assert.equal(await git.locator('.timber-tool-status').getAttribute('aria-label'), 'Completed · exit 0');
    assert.equal(await git.locator('.timber-tool-status').innerText(), '', 'completion is an accessible corner icon, without repetitive visible text');
    assert.equal(await row.locator('.timber-tool-corner .timber-spinner').count(), 1);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tool-operation-id="format-install"] .timber-code pre span[style]')].some(node => node.style.color !== 'inherit'));
    const dimensions = await row.locator('.timber-code [data-code-content]').evaluate(node => ({height: node.getBoundingClientRect().height, scroll: node.scrollWidth, width: node.clientWidth}));
    assert.ok(dimensions.height <= 75, 'long shell commands stay compact');
    if (width === 390) assert.ok(dimensions.scroll > dimensions.width, 'long commands scroll inside their own block');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/activity-formatted-${width}.png`, animations: 'disabled'});}
    await row.locator('summary').click();
    await row.getByRole('button', {name: 'Command', exact: true}).click();
    await row.getByRole('button', {name: 'Copy code', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
    await row.getByRole('button', {name: 'Wrap lines', exact: true}).click();
    assert.equal(await row.getByRole('button', {name: 'Wrap lines', exact: true}).getAttribute('aria-pressed'), 'true');
    assert.equal(await row.locator('.timber-tool-expanded').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    state.emit(BOT_A, 'tool.completed', {operationId: 'format-install', toolName: 'exec', result: {status: 'failed', output: 'Dependency unavailable\n', error: 'Could not resolve the package version.', exitCode: 1}}, run.id);
    await row.locator('summary').filter({hasText: 'Could not resolve the package version.'}).waitFor();
    assert.equal(await row.locator('.timber-tool-status').getAttribute('aria-label'), 'Failed · exit 1');
    assert.equal(await row.locator('.timber-tool-corner .timber-spinner').count(), 0);
    assert.equal(await row.locator('.timber-tool-exit').innerText(), 'exit 1');
    await row.locator('summary').click();
    await openPanel(page, 'activity');
    const panelRow = page.locator('[data-activity-tool-operation-id="format-install"]');
    assert.equal(await panelRow.locator('.timber-tool-kind').getAttribute('aria-label'), 'Packages');
    assert.equal(await panelRow.locator('.timber-tool-status').getAttribute('aria-label'), 'Failed · exit 1');
    assert.match(await panelRow.locator('summary').innerText(), /Could not resolve the package version/);
    assert.equal(await panelRow.locator('details').count(), 0);
  }, {viewport: {width, height: 920}, colorScheme: width === 390 ? 'dark' : 'light'});
});

test('activity highlights files and diffs, renders skill Markdown safely and preserves JSON literals when copying', async () => {
  await withPage(async ({page, context, login, state, url}) => {
    const createdAt = new Date().toISOString(), run = {id: 'formatted-output', botId: BOT_A, operationId: 'output-request', status: 'completed', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [{id: 'output-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Revisá el código, los cambios y la guía.', createdAt}]);
    const python = 'def greet(name: str):\n    return f"Hello, {name}"\n';
    const diff = 'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n';
    const json = '{"ok":true,"files":["app.py","package.json"]}', precise = '{"id":9007199254740993,"value":1.00,"a":1,"a":2}';
    for (const [operationId, toolName, input, output] of [
      ['format-python', 'readFile', {path: 'app.py'}, python], ['format-diff', 'exec', {command: 'git diff'}, diff],
      ['format-json', 'exec', {command: 'curl localhost:3000/api/status'}, json], ['format-precise', 'exec', {command: 'cat data.json'}, precise],
      ['format-skill', 'load_skill', {name: 'workspace-apps'}, '---\nname: workspace-apps\ndescription: Hidden frontmatter\n---\n# Publish the app\n\nUse **named apps**.\n\n```sh\nnpm run dev -- --host 0.0.0.0\n```\n\n<script>globalThis.__unsafeActivity = true</script>\n<img src=x onerror="globalThis.__unsafeActivity = true">\n[Unsafe](javascript:alert(1))'],
    ]) state.emit(BOT_A, 'tool.completed', {operationId, toolName, input, result: {status: 'completed', output}}, run.id);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
    await login();
    for (const [id, language, original] of [['format-python','python',python],['format-diff','diff',diff],['format-json','json',json],['format-precise','json',precise]]) {
      const row = page.locator(`[data-tool-operation-id="${id}"]`);
      await row.locator('summary').click();
      await row.locator(`.timber-tool-output [data-language="${language}"]`).waitFor();
      await page.waitForFunction(id => [...document.querySelectorAll(`[data-tool-operation-id="${id}"] .timber-tool-output pre span[style]`)].some(node => node.style.color !== 'inherit'), id);
      await row.getByRole('button', {name: 'Copy code', exact: true}).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original, 'copy retains original whitespace, numbers and keys');
      if (id === 'format-json') assert.match(await row.locator('.timber-tool-output pre').innerText(), /\n\s+"ok": true/);
      if (id === 'format-precise') assert.match(await row.locator('.timber-tool-output pre').innerText(), /9007199254740993/);
      await row.locator('summary').click();
    }
    const skill = page.locator('[data-tool-operation-id="format-skill"]');
    assert.doesNotMatch(await skill.locator('summary').innerText(), /Hidden frontmatter|description:/);
    await skill.locator('summary').click();
    assert.equal(await skill.locator('.timber-tool-output [data-streamdown="strong"]').innerText(), 'named apps');
    await skill.locator('.timber-tool-output [data-language="bash"]').waitFor();
    assert.equal(await skill.locator('script,img,a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__unsafeActivity), undefined);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/activity-markdown-mobile.png`, animations: 'disabled'});}
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }, {viewport: {width: 390, height: 920}, colorScheme: 'dark'});
});

test('copying either message role preserves the exact source Markdown', async () => {
  await withPage(async ({page, context, login, state, url}) => {
    const user = '  Please keep **this formatting**.\n\n```sh\nprintf "¡Hola!"\n```\n';
    const assistant = '## Result\n\n- **Résumé**\n- A [source](https://example.com/a?q=1)\n\n```text\nline one\nline two\n```\n';
    state.messages.get(BOT_A)[0].text = user; state.messages.get(BOT_A)[1].text = assistant;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
    await login();
    for (const [id, text] of [['message-one', user], ['message-two', assistant]]) {
      const message = page.locator(`[data-message-id="${id}"]`);
      await message.getByRole('button', {name: 'Copy message', exact: true}).click();
      await message.getByRole('status').filter({hasText: /Copied/i}).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, 'clipboard receives original Markdown, including whitespace');
    }
    assert.equal(state.calls.some(call => call.method !== 'GET'), false, 'copy is entirely local');
  });
});

test('clipboard rejection is visible and a later explicit copy can succeed', async () => {
  await withPage(async ({page, login, state}) => {
    await page.addInitScript(() => {
      globalThis.__copyTest = {reject: true, writes: []};
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async text => {
        if (globalThis.__copyTest.reject) throw new DOMException('Clipboard unavailable', 'NotAllowedError');
        globalThis.__copyTest.writes.push(text);
      }}});
    });
    await login(); const message = page.locator('[data-message-id="message-two"]');
    await message.getByRole('button', {name: 'Copy message', exact: true}).click();
    await message.getByRole('status').filter({hasText: /could not|couldn.t|unable|failed/i}).waitFor();
    assert.deepEqual(await page.evaluate(() => globalThis.__copyTest.writes), []);
    assert.equal(await message.getByRole('status').filter({hasText: /^Copied/i}).count(), 0);
    await page.evaluate(() => {globalThis.__copyTest.reject = false;});
    await message.getByRole('button', {name: 'Copy message', exact: true}).click();
    await message.getByRole('status').filter({hasText: /Copied/i}).waitFor();
    assert.deepEqual(await page.evaluate(() => globalThis.__copyTest.writes), [state.messages.get(BOT_A)[1].text]);
  });
});

test('pending and streaming message copy uses the text visible at that moment', async () => {
  await withPage(async ({page, context, login, state, url}) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
    const run = {id: 'copy-stream-run', botId: BOT_A, operationId: 'copy-stream-operation', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
    state.runs.set(BOT_A, [run]); state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: 'A **partial** answer'}, run.id);
    await login();
    await page.getByRole('button', {name: 'Copy response so far', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A **partial** answer');
    state.emit(BOT_A, 'message.delta', {delta: '\n\n```sh\npwd\n```'}, run.id);
    await until(page, '#streaming-text', 'pwd');
    await page.getByRole('button', {name: 'Copy response so far', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A **partial** answer\n\n```sh\npwd\n```');
    let release; state.messageGates.set(BOT_A, new Promise(resolve => {release = resolve;}));
    const text = 'A pending **request**\nwith another line';
    await page.locator('#message').fill(text); await sendMessage(page);
    await page.getByRole('button', {name: 'Copy pending message', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    release();
  });
});

test('bot deletion requires confirmation and retains the captured target during a selection change', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus');
    await page.locator('#message').fill('Keep Linus draft'); await selectBot(page, BOT_A);
    await openDelete(page); assert.match(await page.locator('#delete-title').innerText(), /Ada/);
    await page.locator('#cancel-delete-bot').click(); await page.locator('#delete-dialog').waitFor({state: 'hidden'});
    assert.equal(deletedBots(state).length, 0); assert.equal(state.bots.length, 2);
    if (await page.locator('#edit-dialog').isVisible()) await page.locator('#delete-bot').click(); else await openDelete(page);
    let release; state.deleteGates.set(BOT_A, new Promise(resolve => {release = resolve;}));
    const requested = page.waitForRequest(request => request.method() === 'DELETE');
    await page.locator('#confirm-delete-bot').click(); await requested;
    assert.equal(await page.locator('#confirm-delete-bot').isDisabled(), true); assert.equal(await page.locator('#cancel-delete-bot').isDisabled(), true);
    await page.locator('#delete-form').dispatchEvent('submit');
    await page.evaluate(id => {location.hash = `bot=${id}`;}, BOT_B); await until(page, '#selected-name', 'Linus');
    const completed = page.waitForResponse(response => response.request().method() === 'DELETE'); release(); await completed;
    await page.locator('#delete-dialog').waitFor({state: 'hidden'});
    assert.deepEqual(deletedBots(state).map(call => call.path), [`/v1/bots/${BOT_A}`]);
    assert.deepEqual(state.bots.map(bot => bot.id), [BOT_B]); assert.equal(await page.locator(`[data-bot-id="${BOT_A}"]`).count(), 0);
    assert.equal(await page.locator('#message').inputValue(), 'Keep Linus draft'); assert.equal(await page.locator('#selected-name').innerText(), 'Linus');
  });
});

test('an unconfirmed deletion leaves the bot and draft intact until an explicit successful retry', async () => {
  for (const failure of ['http', 'network']) await withPage(async ({page, login, state}) => {
    await login(); await page.locator('#message').fill('Keep this draft if deletion fails');
    await page.route(`**/v1/bots/${BOT_A}`, route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      return failure === 'network' ? route.abort('failed') : route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {code: 'service_unavailable', message: 'Deletion service unavailable.'}})});
    });
    await openDelete(page); await page.locator('#confirm-delete-bot').click();
    await until(page, '#delete-error', failure === 'http' ? 'Deletion service unavailable.' : /lost|not confirmed|unconfirmed/i);
    assert.equal(state.bots.length, 2); assert.equal(await page.locator(`[data-bot-id="${BOT_A}"]`).count(), 1);
    assert.equal(await page.locator('#message').inputValue(), 'Keep this draft if deletion fails');
    assert.equal(deletedBots(state).length, 0, 'no automatic retry follows the failed attempt');
    await page.unroute(`**/v1/bots/${BOT_A}`);
    await page.locator('#confirm-delete-bot').click(); await page.locator('#delete-dialog').waitFor({state: 'hidden'});
    await until(page, '#selected-name', 'Linus'); assert.deepEqual(state.bots.map(bot => bot.id), [BOT_B]);
  });
});

test('partially completed deletion fences the bot and preserves a cleanup retry for that exact ID', async () => {
  await withPage(async ({page, login, state}) => {
    state.deleteError = {code: 'bot_deletion_pending', message: 'Bot access is disabled. Data cleanup is still pending; retry deletion.', status: 503};
    await login(); await openDelete(page); await page.locator('#confirm-delete-bot').click();
    await until(page, '#delete-error', /cleanup.*pending/i);
    assert.match(await page.locator('#delete-title').innerText(), /Ada/);
    await until(page, '#selected-name', 'Linus'); assert.equal(await page.locator(`[data-bot-id="${BOT_A}"]`).count(), 0);
    assert.equal(state.deletedBots.has(BOT_A), false, 'fixture cleanup has not completed');
    assert.equal(state.deletingBots.has(BOT_A), true); assert.equal(deletedBots(state).length, 1);
    await page.locator('#cancel-delete-bot').click(); await page.locator('#delete-dialog').waitFor({state: 'hidden'});
    await page.locator(`[data-pending-deletion="${BOT_A}"]`).click(); await page.locator('#delete-dialog').waitFor({state: 'visible'});
    assert.match(await page.locator('#delete-title').innerText(), /Ada/);
    state.deleteError = null;
    await page.getByRole('button', {name: 'Retry cleanup', exact: true}).click(); await page.locator('#delete-dialog').waitFor({state: 'hidden'});
    assert.deepEqual(deletedBots(state).map(call => call.path), [`/v1/bots/${BOT_A}`, `/v1/bots/${BOT_A}`]);
    assert.equal(state.deletedBots.has(BOT_A), true); assert.deepEqual(state.bots.map(bot => bot.id), [BOT_B]);
  });
});

test('deleting the final bot clears its conversation, computer view and selection before creating another', async () => {
  await withPage(async ({page, login, state}) => {
    state.bots = state.bots.filter(bot => bot.id === BOT_A);
    await login(); await page.locator('#message').fill('Draft belonging only to the deleted bot');
    await openPanel(page, 'computer'); await page.locator('#computer-tools > summary').click(); await page.locator('#take-screenshot').click(); await page.locator('#screenshot').waitFor({state: 'visible'});
    await openPanel(page, 'conversation'); await openDelete(page); await page.locator('#confirm-delete-bot').click();
    await page.locator('#delete-dialog').waitFor({state: 'hidden'}); await page.locator('#empty').waitFor({state: 'visible'});
    assert.equal(await page.locator('#bot-workspace').isVisible(), false); assert.equal(await page.locator('.bot-item').count(), 0);
    assert.equal(await page.locator('[data-message-id], [data-operation-id], [data-approval-id]').count(), 0);
    assert.equal(await page.locator('#screenshot').getAttribute('src'), null); assert.equal(page.url().includes(BOT_A), false);
    assert.equal(state.messages.has(BOT_A), false); assert.equal(state.runs.has(BOT_A), false); assert.equal(state.approvals.has(BOT_A), false);
    await page.locator('#new-bot').click(); await page.locator('#bot-name').fill('Fresh bot'); await page.locator('#create-form [type=submit]').click();
    await until(page, '#selected-name', 'Fresh bot'); assert.equal(await page.locator('#message').inputValue(), '');
    assert.equal((await page.locator('#messages').innerText()).includes('Three themes'), false);
    assert.equal(state.calls.some(call => call.method === 'DELETE' && call.path.includes('connections')), false, 'shared ChatGPT credentials are not disconnected');
  });
});

test('a late deletion response from an ended session cannot reset the new session view', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let release; state.deleteGates.set(BOT_A, new Promise(resolve => {release = resolve;}));
    await openDelete(page); const requested = page.waitForRequest(request => request.method() === 'DELETE');
    await page.locator('#confirm-delete-bot').click(); await requested;
    // Session shutdown may occur independently of an open modal (for example token expiry).
    await page.locator('#disconnect').evaluate(node => node.click()); await page.locator('#login').waitFor({state: 'visible'});
    await login(); await until(page, '#selected-name', 'Linus'); await page.locator('#message').fill('Draft in the new session');
    release();
    await page.locator('#reload-bots').click(); await until(page, '#selected-name', 'Linus');
    assert.equal(await page.locator('#message').inputValue(), 'Draft in the new session'); assert.equal(await page.locator('#delete-dialog').isVisible(), false);
    assert.equal(state.deletedBots.has(BOT_A), true, 'cleanup completed after the old client session ended');
    assert.deepEqual(deletedBots(state).map(call => call.path), [`/v1/bots/${BOT_A}`]);
  });
});

test('message acceptance is visible immediately and slow history refresh cannot lose a newer draft', async () => {
  await withPage(async ({page, login, state}) => {
    await login();
    let accept, refresh;
    state.messageResponseGates.set(BOT_A, new Promise(resolve => {accept = resolve;}));
    state.readsGate = new Promise(resolve => {refresh = resolve;});
    await page.locator('#message').fill('First accepted request');
    await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Sending');
    await page.locator('#message-form').dispatchEvent('submit');
    await page.locator('#message').fill('My next unsent draft');
    const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith('/messages'));
    const historyRequest = page.waitForRequest(item => item.method() === 'GET' && item.url().endsWith(`/bots/${BOT_A}/messages`));
    accept(); await response;
    assert.equal(sentMessages(state, BOT_A).length, 1, 'in-flight duplicate submission is ignored');
    await until(page, '#messages [data-operation-id]', 'Queued');
    await historyRequest;
    assert.equal(await page.locator('#message').inputValue(), 'My next unsent draft');
    assert.equal(await page.locator('#message-form [type="submit"]').isDisabled(), false, 'POST acceptance releases the composer independently of GET refresh');
    assert.equal(state.runs.get(BOT_A).length, 1);
    state.readsGate = null; refresh();
    await page.locator('[data-message-id]').filter({hasText: 'First accepted request'}).waitFor();
    assert.equal(await page.locator('#messages').getByText('First accepted request', {exact: true}).count(), 1, 'receipt is reconciled with the canonical user message');
    assert.equal(await page.locator('#message').inputValue(), 'My next unsent draft');
  });
});

test('an accepted message with a lost response retries explicitly with the original operation ID', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); await page.clock.install();
    let loseResponse = true;
    await page.route(`**/v1/bots/${BOT_A}/messages`, async route => {
      if (route.request().method() !== 'POST' || !loseResponse) return route.continue();
      loseResponse = false;
      await route.fetch(); // The backend accepted it, but the client never receives the response.
      return route.abort('failed');
    });
    await page.locator('#message').fill('Preserve this operation after a lost response'); await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Delivery unknown');
    await page.clock.fastForward(10_000);
    assert.equal(sentMessages(state, BOT_A).length, 1, 'uncertain delivery never retries without user action');
    const original = sentMessages(state, BOT_A)[0].body;
    await page.clock.resume();
    await page.getByRole('button', {name: 'Retry sending', exact: true}).click();
    await page.locator('[data-message-id]').filter({hasText: original.text}).waitFor();
    const attempts = sentMessages(state, BOT_A);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1].body, original, 'retry keeps both captured text and idempotency key');
    assert.equal(state.runs.get(BOT_A).length, 1);
    assert.equal(state.messages.get(BOT_A).filter(message => message.text === original.text).length, 1);
    assert.equal(await page.locator('#messages').getByText(original.text, {exact: true}).count(), 1);
  });
});

test('a pending send stays scoped to its bot while another bot sends and keeps a newer draft', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let release;
    state.messageResponseGates.set(BOT_A, new Promise(resolve => {release = resolve;}));
    await page.locator('#message').fill('Task captured for Ada'); await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Sending');
    await page.locator('#message').fill('Ada next draft');
    await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus');
    assert.equal(await page.locator('#message').inputValue(), '');
    await page.locator('#message').fill('Independent task for Linus'); await sendMessage(page);
    await page.locator('[data-message-id]').filter({hasText: 'Independent task for Linus'}).waitFor();
    await page.locator('#message').fill('Linus next draft');
    const completed = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(`/bots/${BOT_A}/messages`));
    release(); await completed;
    assert.equal(await page.locator('#message').inputValue(), 'Linus next draft');
    assert.equal((await page.locator('#messages').innerText()).includes('Task captured for Ada'), false);
    await selectBot(page, BOT_A); await until(page, '#selected-name', 'Ada');
    await page.locator('[data-message-id]').filter({hasText: 'Task captured for Ada'}).waitFor();
    assert.equal(await page.locator('#message').inputValue(), 'Ada next draft');
    assert.equal(sentMessages(state, BOT_A).length, 1); assert.equal(sentMessages(state, BOT_B).length, 1);
    assert.notEqual(sentMessages(state, BOT_A)[0].body.operationId, sentMessages(state, BOT_B)[0].body.operationId);
  });
});

test('sending newer text does not discard the retry identity of an earlier uncertain message', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let firstAttempt;
    await page.route(`**/v1/bots/${BOT_A}/messages`, async route => {
      if (route.request().method() === 'POST' && !firstAttempt) {firstAttempt = route.request().postDataJSON(); return route.abort('failed');}
      return route.continue();
    });
    await page.locator('#message').fill('Earlier request not yet delivered'); await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Delivery unknown');
    await page.locator('#message').fill('A newer separate request'); await sendMessage(page);
    await page.locator('[data-message-id]').filter({hasText: 'A newer separate request'}).waitFor();
    await page.getByRole('button', {name: 'Retry sending', exact: true}).click();
    await page.locator('[data-message-id]').filter({hasText: firstAttempt.text}).waitFor();
    const delivered = sentMessages(state, BOT_A);
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered.find(call => call.body.text === firstAttempt.text).body, firstAttempt);
    assert.notEqual(delivered.find(call => call.body.text !== firstAttempt.text).body.operationId, firstAttempt.operationId);
    assert.equal(state.runs.get(BOT_A).length, 2);
    assert.equal(state.messages.get(BOT_A).filter(message => message.text === firstAttempt.text).length, 1);
  });
});

test('a malformed acceptance response cannot confirm delivery or discard its retry identity', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let original;
    await page.route(`**/v1/bots/${BOT_A}/messages`, async route => {
      if (route.request().method() !== 'POST' || original) return route.continue();
      original = route.request().postDataJSON();
      return route.fulfill({status: 202, contentType: 'application/json', body: JSON.stringify({run: {
        id: 'foreign-run', botId: BOT_B, operationId: original.operationId, status: 'queued',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }})});
    });
    await page.locator('#message').fill('Require a matching bot receipt'); await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Delivery unknown');
    assert.equal(state.runs.get(BOT_A).length, 0);
    await page.getByRole('button', {name: 'Retry sending', exact: true}).click();
    await page.locator('[data-message-id]').filter({hasText: original.text}).waitFor();
    assert.equal(sentMessages(state, BOT_A).length, 1);
    assert.deepEqual(sentMessages(state, BOT_A)[0].body, original);
    assert.equal(state.runs.get(BOT_A).length, 1);
  });
});

test('an accepted queued message can retry admission after reconnect without duplicating its conversation entry', async () => {
  await withPage(async ({page, login, state}) => {
    const text = 'Persisted task waiting for runtime admission';
    const run = {id: 'queued-admission-run', botId: BOT_A, operationId: 'queued-admission-operation', status: 'queued',
      error: 'Runtime admission is unavailable. Retry this message to resume the same request.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
    state.runs.set(BOT_A, [run]);
    state.messages.set(BOT_A, [{id: 'queued-admission-message', botId: BOT_A, runId: run.id, role: 'user', text, createdAt: run.createdAt}]);
    state.messageOperations.set(`${BOT_A}:${run.operationId}`, {text, run});
    await login();
    await page.getByRole('button', {name: 'Retry sending', exact: true}).waitFor();
    assert.equal(sentMessages(state, BOT_A).length, 0, 'restoring accepted work never resends automatically');
    await page.locator('#message').fill('Preserve my next unsent task');
    delete run.error;
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
    await page.getByRole('button', {name: 'Retry sending', exact: true}).click(); await accepted;
    await page.getByRole('button', {name: 'Retry sending', exact: true}).waitFor({state: 'hidden'});
    assert.deepEqual(sentMessages(state, BOT_A).map(call => call.body), [{text, operationId: run.operationId}]);
    assert.equal(state.runs.get(BOT_A).length, 1); assert.equal(state.messages.get(BOT_A).length, 1);
    assert.equal(await page.locator('#messages').getByText(text, {exact: true}).count(), 1);
    assert.equal(await page.locator('#message').inputValue(), 'Preserve my next unsent task');
  });
});

test('runtime admission can be retried from a new accepted receipt before history finishes syncing', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let refresh, first = true;
    state.readsGate = new Promise(resolve => {refresh = resolve;});
    await page.route(`**/v1/bots/${BOT_A}/messages`, async route => {
      if (route.request().method() !== 'POST' || !first) return route.continue();
      first = false;
      const response = await route.fetch(), result = await response.json();
      result.run.error = 'Runtime admission is unavailable. Retry this message to resume the same request.';
      Object.assign(state.runs.get(BOT_A)[0], result.run);
      return route.fulfill({response, json: result});
    });
    await page.locator('#message').fill('Accepted before the runtime was available'); await sendMessage(page);
    await until(page, '#messages [data-operation-id]', 'Queued');
    await page.getByRole('button', {name: 'Retry sending', exact: true}).waitFor();
    await page.locator('#message').fill('A new unsent draft stays mine');
    delete state.runs.get(BOT_A)[0].error;
    const retried = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
    await page.getByRole('button', {name: 'Retry sending', exact: true}).click(); await retried;
    assert.equal(sentMessages(state, BOT_A).length, 2);
    assert.deepEqual(sentMessages(state, BOT_A)[1].body, sentMessages(state, BOT_A)[0].body);
    assert.equal(state.runs.get(BOT_A).length, 1);
    assert.equal(await page.locator('#message').inputValue(), 'A new unsent draft stays mine');
    state.readsGate = null; refresh();
    await page.locator('[data-message-id]').filter({hasText: 'Accepted before the runtime was available'}).waitFor();
    assert.equal(await page.locator('#messages').getByText('Accepted before the runtime was available', {exact: true}).count(), 1);
  });
});

test('bot administration, isolated drafts, safe message rendering and session clearing', async () => {
  await withPage(async ({page, login, state}) => {
    state.messages.get(BOT_A)[1].text += '\n\n<img src=x onerror=alert(1)>';
    await login();
    await until(page, '#selected-name', 'Ada');
    assert.equal(await page.locator('#messages img').count(), 0, 'model text cannot inject HTML');
    assert.equal(await page.locator('#messages strong, #messages [data-streamdown="strong"]').innerText(), 'Three themes');
    assert.match(await page.locator('#messages pre').innerText(), /cat notes/);
    await page.locator('#message').fill('Draft only for Ada');
    await page.locator('#bot-search').fill('Linus'); assert.equal(await page.locator('.bot-item').count(), 1);
    await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus'); assert.equal(await page.locator('#message').inputValue(), '');
    await page.locator('#message').fill('Draft only for Linus'); await page.locator('#bot-search').fill('');
    await selectBot(page, BOT_A); await until(page, '#selected-name', 'Ada'); assert.equal(await page.locator('#message').inputValue(), 'Draft only for Ada');
    await openBotEditor(page); await page.locator('#edit-name').fill('Ada research'); await page.locator('#edit-instructions').fill('Keep concise research notes.'); await page.locator('#edit-form [type=submit]').click(); await until(page, '#selected-name', 'Ada research');
    assert.equal(state.bots[0].instructions, 'Keep concise research notes.');
    await page.locator('#new-bot').click(); await page.locator('#bot-name').fill('Grace'); await page.locator('#bot-instructions').fill('Review software.'); await page.locator('#create-form [type=submit]').click(); await until(page, '#selected-name', 'Grace');
    assert.equal(state.bots[0].name, 'Grace'); assert.match(page.url(), /#bot=/);
    const storage = await page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}})); assert.equal(JSON.stringify(storage).includes(TEST_TOKEN), false);
    await signOut(page); await page.locator('#login').waitFor({state: 'visible'}); assert.equal(await page.locator('#token').inputValue(), ''); assert.deepEqual((await page.locator('#messages').allTextContents()).filter(text => text.trim()), [], 'disconnect clears or unmounts conversation content');
    await login(); assert.equal(await page.locator('#message').inputValue(), '', 'drafts removed on disconnect');
    await page.reload(); await page.locator('#bot-workspace').waitFor({state: 'visible'}); assert.equal(await page.locator('#login').isVisible(), false, 'the authenticated session survives reload');
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
    await openBotEditor(page); assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'ask');
    assert.match(await page.locator('#edit-computer-approval-help').innerText(), /commands, file changes and desktop control/);
    assert.match(await page.locator('#edit-computer-approval-help').innerText(), /Existing requests stay unchanged/);
    await page.locator('#edit-computer-approval-mode').selectOption('automatic'); await page.locator('#edit-form [type=submit]').click();
    await until(page, '#selected-computer-mode', 'Use authorized');
    assert.equal(state.bots.find(bot => bot.id === BOT_A).computerApprovalMode, 'automatic');
    assert.equal(state.calls.find(call => call.method === 'PATCH').body.computerApprovalMode, 'automatic');
    await signOut(page); await login(); await openBotEditor(page);
    assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'automatic', 'saved permission survives reconnect');
    await page.locator('#edit-computer-approval-mode').selectOption('ask'); await page.locator('#edit-form [type=submit]').click();
    await until(page, '#selected-computer-mode', 'Ask for each action'); assert.equal(state.bots.find(bot => bot.id === BOT_A).computerApprovalMode, 'ask');
    await page.locator('#new-bot').click(); assert.equal(await page.locator('#bot-computer-approval-mode').inputValue(), 'ask');
    await page.locator('#bot-name').fill('Authorized bot'); await page.locator('#bot-computer-approval-mode').selectOption('automatic');
    await page.locator('#create-form [type=submit]').click(); await until(page, '#selected-name', 'Authorized bot'); await until(page, '#selected-computer-mode', 'Use authorized');
    assert.equal(state.bots[0].computerApprovalMode, 'automatic');
    await openBotEditor(page); assert.equal(await page.locator('#edit-computer-approval-mode').inputValue(), 'automatic'); await page.locator('#edit-dialog [data-close-dialog]').first().click();
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
    await openPanel(page, 'runs'); await page.locator('#load-more-runs').waitFor({state: 'visible'}); await page.locator('#load-more-runs').click();
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
    state.approvals.set(BOT_A, [approval]); await login(); await openPanel(page, 'computer'); await page.locator('#close-computer').click();
    assert.equal(await page.locator('#panel-conversation').isVisible(), true); assert.equal((await page.locator('#messages').innerText()).includes(approval.action.text), false);
    await page.locator('#messages').getByRole('button', {name: 'Deny', exact: true}).click(); await page.locator('#approval-shortcut').waitFor({state: 'hidden'}); assert.equal(approval.status, 'denied');
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
    const cards = page.locator('#messages [data-approval-status="interrupted"]');
    assert.equal(await cards.count(), 8, 'all returned interrupted approvals remain accessible');
    assert.equal(await page.locator('[data-approval-history-id][open]').count(), 0);
    for (const summary of await page.locator('[data-approval-history-id] summary').all()) await summary.click();
    assert.equal(await cards.first().getAttribute('data-approval-id'), interrupted[0].id);
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
    await openPanel(page, 'activity');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    await openPanel(page, 'conversation'); assert.equal(await cards.count(), 8);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false, 'loading and refreshing diagnostics never retries or decides an action');
    assert.equal(state.actions.length, 0);
  });
});

const pendingApproval = (id = 'current-request', minute = 20) => ({id, botId: BOT_A, runId: 'pending-run', operationId: `operation-${id}`, status: 'pending', action: {type: 'exec', command: `printf ${id}`}, createdAt: new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString()});

test('approvals appear chronologically inline with messages on desktop and mobile', async () => {
  for (const width of [1440, 390]) await withPage(async ({page, login, state}) => {
    state.messages.set(BOT_A, Array.from({length: 80}, (_, i) => ({id: `long-${i}`, botId: BOT_A, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: ${'Long conversation text. '.repeat(15)}`, createdAt: '2026-10-06T10:00:00Z'})));
    state.approvals.set(BOT_A, Array.from({length: 12}, (_, i) => pendingApproval(`older-${i}`, i)));
    state.messages.get(BOT_A).push({id: 'latest-request', botId: BOT_A, runId: 'pending-run', role: 'user', text: 'Run the current command and show me its output.', createdAt: pendingApproval().createdAt}, {id: 'ready-for-review', botId: BOT_A, runId: 'pending-run', role: 'assistant', text: 'The command is ready for your review.', createdAt: pendingApproval().createdAt});
    await login();
    state.approvals.get(BOT_A).push(pendingApproval()); state.emit(BOT_A, 'approval.created', {approval: pendingApproval()}, 'pending-run');
    await page.locator('#current-approval[data-approval-id="current-request"]').waitFor();
    await page.evaluate(() => {const history = document.querySelector('#messages'); history.scrollTop = history.scrollHeight; document.querySelector('#message-form').scrollIntoView({block: 'end'});});
    assert.equal(await page.locator('[data-approval-history-id][open]').count(), 0);
    assert.equal(await page.locator('#messages [data-approval-history-id]').count(), 12);
    const button = page.locator('#current-approval [data-approval-decision="approve"]'), bounds = await button.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1000, `current approve button stays visible at the timeline bottom on ${width}px`);
    assert.match(await page.locator('#current-approval pre').innerText(), /printf current-request/);
    const layout = await page.evaluate(() => ({history: document.querySelector('#messages').getBoundingClientRect().bottom, approval: document.querySelector('#current-approval').getBoundingClientRect().top, composer: document.querySelector('#message-form').getBoundingClientRect().top}));
    assert.ok(layout.approval < layout.history && layout.composer > layout.approval);
    assert.equal(await page.locator('#messages #current-approval').count(), 1, 'current approval stays inside the conversation timeline');
    assert.equal(await page.locator('#approvals').count(), 0);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/approval-${width}.png`});}
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false);
  }, {viewport: {width, height: 1000}});
});

test('timeline ties preserve user request, approval, then answer and retain a reviewed scroll position', async () => {
  await withPage(async ({page, login, state}) => {
    const approval = pendingApproval(), timestamp = approval.createdAt;
    state.approvals.set(BOT_A, [approval]);
    state.messages.set(BOT_A, [
      {id: 'tie-user', botId: BOT_A, runId: approval.runId, role: 'user', text: 'Run the command.', createdAt: timestamp},
      {id: 'tie-answer', botId: BOT_A, runId: approval.runId, role: 'assistant', text: 'The requested command is ready for review.', createdAt: timestamp},
      {id: 'tie-user-second', botId: BOT_A, runId: 'second-run', role: 'user', text: 'A second request.', createdAt: timestamp},
      {id: 'tie-answer-second', botId: BOT_A, runId: 'second-run', role: 'assistant', text: 'A second answer.', createdAt: timestamp},
      ...Array.from({length: 30}, (_, i) => ({id: `later-${i}`, botId: BOT_A, role: 'assistant', text: `Later message ${i}. ${'History text. '.repeat(15)}`, createdAt: '2026-10-06T12:00:00Z'})),
    ]);
    await login();
    const order = await page.locator('#messages').evaluate(node => [...node.querySelectorAll('[data-message-id], [data-timeline-approval]')].map(item => item.dataset.messageId || item.dataset.timelineApproval));
    assert.deepEqual(order.slice(0, 5), ['tie-user', approval.id, 'tie-answer', 'tie-user-second', 'tie-answer-second'], 'tied approval follows its request while canonical message order is preserved');
    await page.locator('#messages').evaluate(node => {node.scrollTop = 160;});
    const before = await page.locator('#messages').evaluate(node => node.scrollTop);
    state.emit(BOT_A, 'approval.updated', {approval}, approval.runId);
    await page.waitForResponse(response => response.url().endsWith('/approvals'));
    await page.waitForFunction(expected => document.querySelector('#messages').scrollTop === expected, before);
    await openPanel(page, 'computer'); await page.locator('#close-computer').click();
    await page.waitForFunction(expected => document.querySelector('#messages').scrollTop === expected, before);
  });
});

test('saved mobile reply renders the screenshot Markdown as headings, emphasis and code', async () => {
  await withPage(async ({page, login, state}) => {
    const text = 'La prueba funcionó. **El código que apareció fue `360068`**, leído únicamente de la captura posterior al clic.\n\n### Resultados reales de Linux\n\n**`uname -a`:**\n```text\nLinux f4678a333d61e228db1d264bc67f4dc0f38109346cb726b155ad9eda9df7cc 6.18.54-cloudflare-microvm-2026.9.16 #1 SMP PREEMPT_DYNAMIC Mon Sep 27 00:00:00 UTC 2010 x86_64 GNU/Linux\n```';
    state.messages.set(BOT_A, [{id:'screenshot-format',botId:BOT_A,role:'assistant',text,createdAt:'2026-10-06T19:17:28Z'}]);
    await login();
    const reply=page.locator('[data-message-id="screenshot-format"]');
    assert.equal(await reply.locator('h3').innerText(),'Resultados reales de Linux');
    assert.equal(await reply.locator('[data-streamdown="strong"]').first().innerText(),'El código que apareció fue 360068');
    assert.equal(await reply.locator('[data-streamdown="strong"] code').first().innerText(),'360068');
    assert.match(await reply.locator('pre code').innerText(),/^Linux f4678a/);
    assert.doesNotMatch(await reply.innerText(),/\*\*|###|```/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await reply.scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/saved-markdown-mobile.png`});}
  },{viewport:{width:390,height:844},colorScheme:'dark'});
});

test('streamed Markdown preserves recovered prefixes, open fences, replay order and the final transcript', async () => {
  for (const width of [1440, 390]) await withPage(async ({page, login, state}) => {
    const run = {id: 'stream-run', botId: BOT_A, operationId: 'stream-operation', status: 'running', createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z'};
    const user = {id: 'stream-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Ejecutá `uname -a && pwd` y verificá el archivo antes de preparar la página.', createdAt: run.createdAt};
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [user]);
    const prefix = state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: 'La sal'}, run.id);
    const firstDelta = state.emit(BOT_A, 'message.delta', {delta: 'ida de `uname -a && pwd` es:\n\n```te'}, run.id);
    await login(); await until(page, '#streaming-text', 'La salida');
    state.emit(BOT_A, 'message.delta', {delta: 'xt\nLinux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>'}, run.id);
    await until(page, '#streaming-text pre', '/workspace');
    const partial = 'La salida de `uname -a && pwd` es:\n\n```text\nLinux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>';
    assert.equal(await page.locator('#streaming-text p code').innerText(), 'uname -a && pwd');
    assert.equal(await page.locator('#streaming-text pre code').innerText(), 'Linux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>', 'an unfinished fence is already a multiline code block');
    assert.equal(await page.locator('#streaming-text img').count(), 0);
    state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: partial}, run.id);
    state.deliver(firstDelta); state.deliver(prefix);
    const suffix = '\n```\n\nTerminó con código de salida `0`.\nAhora preparo la página.\n\n- Archivo verificado\n- Servidor pendiente';
    state.emit(BOT_A, 'message.delta', {delta: suffix}, run.id);
    await until(page, '#streaming-text', 'Servidor pendiente');
    assert.equal((await page.locator('#streaming-text').innerText()).split('La salida').length - 1, 1, 'snapshot replaces instead of duplicating the prefix');
    assert.equal(await page.locator('#streaming-text p').count(), 2); assert.equal(await page.locator('#streaming-text li').count(), 2);
    assert.match(await page.locator('#streaming-text p').last().textContent(), /`?0`?\.\nAhora preparo/);
    assert.equal(await page.locator('#streaming-text pre code').innerText(), 'Linux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>');
    const recovered = page.waitForResponse(response => response.url().includes('/events?after=')); await page.locator('#reconnect-stream').evaluate(node => node.click()); await recovered;
    assert.equal(await page.locator('#streaming-text p').first().innerText(), 'La salida de uname -a && pwd es:');
    await page.locator('#streaming-message').scrollIntoViewIfNeeded();
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/streaming-${width}.png`});}
    const final = {id: 'stream-final', botId: BOT_A, runId: run.id, role: 'assistant', text: partial + suffix, createdAt: '2026-10-06T12:01:00Z'};
    state.messages.set(BOT_A, [user, final]); state.emit(BOT_A, 'message.created', {message: final}, run.id);
    run.status = 'completed'; run.updatedAt = final.createdAt; state.emit(BOT_A, 'run.updated', {run}, run.id);
    await page.locator('#streaming-message').waitFor({state: 'hidden'}); await until(page, '[data-message-id="stream-final"]', 'Servidor pendiente');
    assert.equal(await page.locator('[data-message-id="stream-final"]').count(), 1); assert.equal(await page.locator('#messages pre code').innerText(), 'Linux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>');
    state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: 'stale ghost'}, run.id); state.emit(BOT_A, 'message.delta', {delta: 'must not return'}, run.id);
    assert.equal(await page.locator('#streaming-message').isVisible(), false); assert.equal(await page.locator('#messages img').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }, {viewport: {width, height: 1000}, colorScheme: 'dark'});
});

test('combined approval patches then approves once despite refreshes and bot switches', async () => {
  await withPage(async ({page, login, state}) => {
    const approval = pendingApproval(); state.approvals.set(BOT_A, [approval]); await login();
    let release; state.patchGate = new Promise(resolve => {release = resolve;});
    const patch = page.waitForRequest(request => request.method() === 'PATCH');
    await page.locator('[data-approval-decision="approve-and-allow"]').click(); await patch;
    await openPanel(page, 'activity');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    await openPanel(page, 'conversation');
    assert.equal(await page.locator('#current-approval button:disabled').count(), 3, 'rerender retains all disabled decision controls');
    await page.locator('[data-approval-decision="approve-and-allow"]').dispatchEvent('click');
    await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus');
    const approved = page.waitForResponse(response => response.url().endsWith(`/approvals/${approval.id}`)); release(); await approved;
    await selectBot(page, BOT_A); await until(page, '#selected-computer-mode', 'Use authorized');
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
    await openPanel(page, 'activity'); await Promise.all([page.waitForResponse(response => response.url().endsWith('/approvals')), page.locator('#refresh-history').click()]);
    assert.equal(state.calls.filter(call => call.method === 'PATCH').length, failure === 'patch-network' ? 0 : 1);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, failure === 'approval-expired' ? 1 : 0);
    assert.equal(approval.status, 'pending'); assert.equal(state.actions.length, 0);
  });
});

test('logout stops the combined action before its approval follow-up', async () => {
  await withPage(async ({page, login, state}) => {
    state.approvals.set(BOT_A, [pendingApproval()]); await login(); let release; state.patchGate = new Promise(resolve => {release = resolve;});
    const patch = page.waitForRequest(request => request.method() === 'PATCH'); await page.locator('[data-approval-decision="approve-and-allow"]').click(); await patch;
    await signOut(page); release(); await page.locator('#login').waitFor({state: 'visible'});
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
    await page.locator('[data-approval-history-id="expired-request"] summary').click();
    assert.equal(await page.locator('[data-approval-status="expired"] button').count(), 0);
    assert.match(await page.locator('[data-approval-status="expired"]').innerText(), /request expired/i);
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
    await openPanel(page, 'computer'); await until(page, '#computer-status', 'starting');
    const reads = () => state.calls.filter(call => call.path.endsWith('/computer')).length;
    state.computerStates.set(BOT_A, {state: 'running'});
    const ready = page.waitForResponse(response => response.url().endsWith('/computer')); await page.clock.fastForward(1600); await ready;
    await until(page, '#computer-status', 'running'); const settledReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), settledReads);
    state.computerStates.set(BOT_A, {state: 'unavailable', error: {code: 'computer_health_unavailable', message: 'Computer control server did not respond.'}});
    const health = page.waitForResponse(response => response.url().endsWith('/computer')); state.emit(BOT_A, 'computer.action', {}); await page.clock.fastForward(300); await health;
    await until(page, '#computer-status', 'Computer control server did not respond.'); assert.match(await page.locator('#computer-status').innerText(), /computer_health_unavailable/);
    const unavailableReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), unavailableReads);
    state.computerStates.set(BOT_A, {state: 'starting'}); await page.locator('#refresh-computer').click(); await until(page, '#computer-status', 'starting');
    await openPanel(page, 'activity'); const hiddenReads = reads(); await page.clock.fastForward(5000); assert.equal(reads(), hiddenReads);
    let release; state.computerStatusGate = new Promise(resolve => {release = resolve;});
    const requested = page.waitForRequest(request => request.url().endsWith(`/bots/${BOT_A}/computer`)); await openPanel(page, 'computer'); await requested;
    state.computerStatusGate = null; await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus'); await until(page, '#computer-status', 'running');
    const late = page.waitForResponse(response => response.url().endsWith(`/bots/${BOT_A}/computer`)); release(); await late;
    await page.clock.fastForward(2000); assert.match(await page.locator('#computer-status').innerText(), /^running/);
    const finalReads = reads(); await signOut(page); await page.clock.fastForward(5000); assert.equal(reads(), finalReads);
    assert.equal(state.calls.some(call => call.method !== 'GET'), false); assert.equal(state.actions.length, 0);
  });
});

test('computer actions require explicit screen input and preserve responsive progress and file paths', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); await openPanel(page, 'computer'); await page.locator('#computer-tools > summary').click();
    let release; state.actionGate = new Promise(resolve => {release = resolve;});
    await page.locator('#take-screenshot').click(); await page.locator('#computer-progress').waitFor({state: 'visible'}); assert.equal(await page.locator('#take-screenshot').isDisabled(), true);
    release(); state.actionGate = null; await page.locator('#screenshot').waitFor({state: 'visible'}); await page.locator('#computer-progress').waitFor({state: 'hidden'});
    await page.waitForFunction(() => document.querySelector('#screenshot').naturalWidth === 1280);
    await page.locator('#screenshot').click(); assert.equal(state.actions.filter(item => item.action.type === 'click').length, 0);
    await page.locator('#click-mode').check(); const imageBox = await page.locator('#screenshot').boundingBox(); await page.locator('#screenshot').click({position: {x: imageBox.width / 2, y: imageBox.height / 2}}); await page.locator('#computer-progress').waitFor({state: 'hidden'});
    const click = state.actions.find(item => item.action.type === 'click').action; assert.ok(Math.abs(click.x - 640) <= Math.ceil(1280 / imageBox.width) && Math.abs(click.y - 400) <= Math.ceil(800 / imageBox.height), `mapping stays within one rendered pixel after integer pointer coordinates: ${JSON.stringify({click, imageBox})}`);
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
    await openPanel(page, 'activity'); await page.locator('#refresh-history').click();
    state.readsGate = null; await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus'); release();
    await openPanel(page, 'conversation'); await until(page, '#messages', 'Ask Linus'); assert.equal((await page.locator('#messages').innerText()).includes('Three themes'), false);
    state.rejectAuth = true; await page.locator('#reload-bots').click(); await page.locator('#login').waitFor({state: 'visible'}); assert.match(await page.locator('#login-error').innerText(), /session expired/i); assert.equal(await page.locator('#token').inputValue(), '');
  });
});

test('desktop and mobile panels remain within the viewport in light and dark themes', async () => {
  await withPage(async ({page, login}) => {
    await login();
    for (const [width, colorScheme] of [[1440, 'light'], [390, 'light'], [390, 'dark']]) {
      await page.setViewportSize({width, height: 1000}); await page.emulateMedia({colorScheme});
      for (const panel of ['conversation', 'runs', 'computer', 'activity']) {
        await openPanel(page, panel);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(overflow <= 1, `${panel} overflows viewport by ${overflow}px at ${width}px`);
      }
      if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await openPanel(page, 'conversation'); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/console-${width}-${colorScheme}.png`, fullPage: true});}
    }
  });
});

test('GitHub repository connection stays inline and updates when access is connected', async () => {
  await withPage(async ({page, context, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'github-run', botId: BOT_A, operationId: 'github-operation', status: 'waiting_connection', createdAt, updatedAt: createdAt};
    const connection = {id: 'github-request', botId: BOT_A, runId: run.id, provider: 'github', repository: 'example/private-repo', permission: 'write', status: 'pending', createdAt};
    state.runs.set(BOT_A, [run]); state.connections.set(BOT_A, [connection]);
    state.messages.set(BOT_A, [{id: 'github-user', botId: BOT_A, runId: run.id, role: 'user', text: 'Clone my repository and open a pull request.', createdAt}]);
    await login();
    const card = page.locator('[data-connection-id="github-request"]');
    await card.filter({hasText: 'Connect GitHub to continue'}).waitFor();
    assert.equal(await card.evaluate(node => Boolean(node.closest('#messages'))), true, 'connection is in the conversation');
    assert.equal(await card.evaluate(node => Boolean(document.querySelector('[data-message-id="github-user"]').compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'connection follows its request');
    assert.match(await card.innerText(), /example\/private-repo/); assert.match(await card.innerText(), /write access/);
    assert.equal(await card.getAttribute('data-connection-status'), 'pending');
    assert.equal(await page.locator('.timber-work-status').isVisible(), false, 'the inline connection request owns the waiting status');
    const newTab = context.waitForEvent('page'); await card.getByRole('button', {name: 'Connect GitHub', exact: true}).click();
    const consent = await newTab; await consent.waitForURL('**/github-connect');
    assert.equal(await consent.evaluate(() => window.opener), null);
    assert.equal(new URL(consent.url()).search, '', 'no owner credentials in the navigation');
    assert.equal(state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/connect')).length, 1);
    await card.filter({hasText: 'Finish in GitHub'}).waitFor();
    connection.status = 'connected'; run.status = 'running'; run.updatedAt = new Date(Date.now() + 1000).toISOString();
    state.emit(BOT_A, 'connection.updated', {connection}, run.id); state.emit(BOT_A, 'run.updated', {run}, run.id);
    await card.filter({hasText: 'GitHub access connected'}).waitFor(); await until(page, '.timber-work-status', 'Ada is working');
    assert.equal(await card.locator('button').count(), 0); assert.equal(sentMessages(state, BOT_A).length, 0, 'client does not duplicate the task when consent finishes');
  });
});

test('workspace apps have independent protected links and open without sending the owner token', async () => {
  for (const width of [1440, 390]) await withPage(async ({page, context, login, state, url}) => {
    const createdAt = new Date().toISOString();
    state.apps.set(BOT_A, [
      {id: 'frontend', botId: BOT_A, name: 'Storefront', port: 3000, basePath: '/apps/frontend/', url: state.appURL(BOT_A, 'frontend'), state: 'ready', createdAt, updatedAt: createdAt},
      {id: 'admin', botId: BOT_A, name: 'Admin', port: 3001, basePath: '/apps/admin/', url: state.appURL(BOT_A, 'admin'), state: 'unavailable', createdAt, updatedAt: createdAt},
    ]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
    await login(); await openPanel(page, 'apps');
    assert.equal(await page.locator('[data-app-id]').count(), 2); assert.equal(await page.locator('#app-count').textContent(), '2');
    assert.equal(await page.getByRole('button', {name: 'Open Admin', exact: true}).isDisabled(), true);
    assert.match(await page.locator('[data-app-id="admin"]').innerText(), /not responding/);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true}); await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/workspace-apps-${width}.png`, animations: 'disabled', fullPage: true});}
    const opened = context.waitForEvent('page'); await page.getByRole('button', {name: 'Open Storefront', exact: true}).click();
    const app = await opened; await app.getByRole('heading', {name: 'Workspace app is available'}).waitFor();
    assert.equal(app.url(), state.apps.get(BOT_A)[0].url); assert.equal(await app.evaluate(() => window.opener), null);
    const exchanges = state.previewCalls.filter(call => call.method === 'POST' && call.url === '/access');
    assert.equal(exchanges.length, 1, 'opening the app exchanges exactly one ticket');
    assert.equal(exchanges[0].origin, new URL(url).origin, 'browser sends the real console origin for the ticket exchange');
    assert.ok([undefined, `${new URL(url).origin}/`].includes(exchanges[0].referer), 'referrers cannot expose console paths or queries');
    assert.equal(new URLSearchParams(exchanges[0].body).get('ticket'), 'fixture-ticket-frontend');
    await app.getByRole('button', {name: 'Save draft', exact: true}).click();
    await app.getByText('Draft saved', {exact: true}).waitFor();
    // Full Chrome may request a favicon after the navigation, unlike the local
    // headless shell. Exercise that extra browser request deterministically.
    await app.evaluate(async () => {await fetch('/favicon.ico', {cache: 'no-store'});});
    const appPath = new URL(state.apps.get(BOT_A)[0].url).pathname;
    const submissions = state.previewCalls.filter(call => call.method === 'POST' && call.url === appPath);
    assert.equal(submissions.length, 1, 'the form submits once to its own app');
    assert.equal(submissions[0].origin, state.previewOrigin, 'forms inside the app retain their same-origin provenance');
    assert.equal(new URLSearchParams(submissions[0].body).get('draft'), 'example');
    assert.equal(state.previewCalls.filter(call => call.method === 'POST').length, 2, 'only the ticket exchange and explicit form submission mutate preview state');
    assert.equal(state.previewCalls.every(call => !call.authorization && !JSON.stringify(call).includes(TEST_TOKEN)), true, 'owner token never reaches any preview request, including browser resources');
    assert.equal(state.previewCalls.every(call => !call.url.includes('ticket')), true, 'ticket stays out of all preview URLs');
    await page.getByRole('button', {name: 'Copy Storefront link', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), state.apps.get(BOT_A)[0].url);
    const admin = page.locator('[data-app-id="admin"]'); await admin.locator('summary').click(); await admin.getByRole('button', {name: 'Remove access', exact: true}).click();
    await admin.waitFor({state: 'hidden'}); assert.equal(await page.locator('[data-app-id="frontend"]').count(), 1);
    assert.equal(state.apps.get(BOT_A).length, 1); assert.equal(state.actions.length, 0, 'opening and removing access do not run computer commands');
    assert.match(await page.locator('#apps-feedback').innerText(), /server and files were kept/);
    await selectBot(page, BOT_B); await page.locator('#workspace-app-empty').waitFor();
    assert.equal(await page.locator('[data-app-id]').count(), 0, 'apps remain scoped to their bot');
  }, {viewport: {width, height: 1000}});
});

test('disconnecting while app access is being prepared closes the tab without disclosing a ticket', async () => {
  await withPage(async ({page, context, login, state}) => {
    const createdAt = new Date().toISOString();
    state.apps.set(BOT_A, [{id: 'slow-app', botId: BOT_A, name: 'Slow app', port: 3000, basePath: '/', url: state.appURL(BOT_A, 'slow-app'), state: 'ready', createdAt, updatedAt: createdAt}]);
    let release; state.appOpenGate = new Promise(resolve => {release = resolve;});
    try {
      await login(); await openPanel(page, 'apps');
      const opened = context.waitForEvent('page'); await page.getByRole('button', {name: 'Open Slow app', exact: true}).click(); const tab = await opened;
      await signOut(page); release();
      if (!tab.isClosed()) await tab.waitForEvent('close');
      assert.equal(state.previewCalls.length, 0); assert.equal(await page.locator('#workspace-app-list').textContent(), '');
    } finally {release();}
  });
});

test('apps remain a named collection on mobile and unsafe addresses never become clickable', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    state.apps.set(BOT_A, [{id: 'invalid', botId: BOT_A, name: 'Example application with a long name', port: 3000, basePath: '/', url: 'javascript:alert(1)', state: 'ready', createdAt, updatedAt: createdAt}]);
    await login(); await openPanel(page, 'apps');
    const card = page.locator('[data-app-id="invalid"]');
    assert.equal(await card.getByRole('button', {name: /^Open /}).isDisabled(), true);
    assert.equal(await card.getByRole('button', {name: /^Copy /}).isDisabled(), true);
    assert.equal(await page.locator('#panel-apps').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator('#panel-apps input').count(), 0, 'user is not required to configure ports');
  }, {viewport: {width: 390, height: 900}});
});

test('Refresh apps explicitly checks services while background lists remain passive', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString(), appId = 'starting-web';
    state.apps.set(BOT_A, [{id: appId, botId: BOT_A, name: 'Website', port: 3000, basePath: '/', url: state.appURL(BOT_A, appId), state: 'unavailable', createdAt, updatedAt: createdAt}]);
    state.appRefreshStates.set(`${BOT_A}:${appId}`, 'ready');
    await login(); await openPanel(page, 'apps');
    const open = page.getByRole('button', {name: 'Open Website', exact: true});
    assert.equal(await open.isDisabled(), true);
    assert.equal(state.calls.some(call => call.path.endsWith('/apps/refresh')), false, 'selecting the bot and viewing its apps do not probe services');
    let release; state.appRefreshGate = new Promise(resolve => {release = resolve;});
    try {
      await page.locator('#refresh-apps').click();
      await page.getByRole('button', {name: 'Checking apps…', exact: true}).waitFor();
      assert.equal(await page.locator('#refresh-apps').isDisabled(), true, 'an in-flight explicit check cannot be duplicated');
      release();
      await page.locator('[data-app-id="starting-web"]').filter({hasText: 'Ready to use'}).waitFor();
      assert.equal(await open.isEnabled(), true);
      assert.deepEqual(state.calls.filter(call => call.path.endsWith('/apps/refresh')).map(call => ({path: call.path, method: call.method})), [{path: `/v1/bots/${BOT_A}/apps/refresh`, method: 'POST'}]);
      assert.equal(state.actions.length, 0);
    } finally {release();}
  });
});


test('GitHub account setup works in Settings without any bot', async () => {
  await withPage(async ({page, context, state, url}) => {
    state.bots = [];
    await page.goto(url); await page.locator('#token').fill(TEST_TOKEN); await page.locator('#connect-form button').click();
    await page.locator('#settings-button').click();
    await until(page, '#github-status', 'Not connected');
    const newTab = context.waitForEvent('page'); await page.locator('#connect-github').click();
    const consent = await newTab; await consent.waitForURL('**/github-connect');
    assert.equal(await consent.evaluate(() => window.opener), null);
    assert.equal(state.calls.filter(call => call.method === 'POST' && call.path === '/v1/connections/github/connect').length, 1);
    assert.equal(state.calls.filter(call => call.method === 'POST' && call.path.startsWith('/v1/bots')).length, 0);
    state.githubConnected = true; await page.locator('#refresh-github').click();
    await until(page, '#github-status', 'Connected');
    assert.equal(await page.locator('#connect-github').isVisible(), false);
    assert.equal(await page.locator('#disconnect-github').isVisible(), true);
  });
});

test('GitHub account connection card needs no repository', async () => {
  await withPage(async ({page, login, state}) => {
    const createdAt = new Date().toISOString();
    const run = {id: 'account-run', botId: BOT_A, operationId: 'account-op', status: 'waiting_connection', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]);
    state.connections.set(BOT_A, [{id: 'account-request', botId: BOT_A, runId: run.id, provider: 'github', permission: 'read', status: 'pending', createdAt}]);
    await login();
    const card = page.locator('[data-connection-id="account-request"]');
    await card.filter({hasText: 'One connection for all your bots'}).waitFor();
    assert.equal(await card.getByRole('button', {name: 'Connect GitHub', exact: true}).isVisible(), true);
    assert.equal((await card.innerText()).includes('undefined'), false);
  });
});

test('console session survives reload and another tab while keeping the API token out of browser storage', async () => {
  await withPage(async ({page, context, login, state, url}) => {
    await login();
    const persistedCookies = (await context.cookies()).filter(cookie => cookie.name === 'timber_fixture_session');
    assert.equal(persistedCookies.length, 1);
    assert.equal(persistedCookies[0].httpOnly, true, 'session credential is inaccessible to application JavaScript');
    assert.ok(persistedCookies[0].expires > Date.now() / 1000, 'session cookie is persistent');
    assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.evaluate(() => document.cookie.includes('timber_fixture_session')), false);
    assert.equal(await page.evaluate(token => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}}).includes(token), TEST_TOKEN), false);
    assert.equal(page.url().includes(TEST_TOKEN), false);
    await page.reload(); await page.locator('#bot-workspace').waitFor({state: 'visible'});
    await until(page, '#selected-name', 'Ada');
    const anotherTab = await context.newPage();
    try {
      await anotherTab.goto(url + '#bot=' + BOT_B); await anotherTab.locator('#bot-workspace').waitFor({state: 'visible'});
      await until(anotherTab, '#selected-name', 'Linus');
      assert.equal(await anotherTab.locator('#login').isVisible(), false);
      // Browser resources do not use the authenticated API fetch wrapper.
      await anotherTab.evaluate(async () => {await fetch('/favicon.ico', {cache: 'no-store'});});
      assert.equal(state.sessionCalls.filter(call => call.method === 'POST').length, 1, 'reload and a new tab reuse the same session');
      assert.deepEqual(state.sessionCalls.filter(call => call.hasBearer).map(call => call.method), ['POST'], 'only the login exchange receives the API token');
      assert.equal(state.requestAuth.every(call => !call.hasBearer), true, 'no API or browser-resource request receives the API token');
      const apiRequests = state.requestAuth.filter(call => new URL(call.path, url).pathname.startsWith('/v1/'));
      assert.ok(apiRequests.length > 0, 'the restored tabs make authenticated API requests');
      assert.equal(apiRequests.every(call => call.hasCookie && call.client === 'console'), true, 'all API requests reuse the cookie through the console client');
      await signOut(page); await page.locator('#login').waitFor({state: 'visible'});
      assert.equal((await context.cookies()).some(cookie => cookie.name === 'timber_fixture_session'), false);
      await anotherTab.reload(); await anotherTab.locator('#login').waitFor({state: 'visible'});
      assert.equal(await anotherTab.locator('#app').isVisible(), false, 'logging out also invalidates a restored tab');
      assert.equal(state.sessionCalls.filter(call => call.method === 'DELETE').length, 1);
    } finally {await anotherTab.close();}
  });
});

test('an expired persisted session returns to sign in without showing the old bot conversation', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); state.sessions.clear();
    await page.reload(); await page.locator('#login').waitFor({state: 'visible'});
    assert.equal(await page.locator('#app').isVisible(), false);
    assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.locator('#messages').isVisible(), false);
  });
});

test('mobile opens the bot list, uses full-screen conversation navigation and keeps per-bot drafts', async () => {
  await withPage(async ({page, login}) => {
    await login({selectFirstBot: false});
    assert.equal(await page.locator('body').getAttribute('data-mobile-view'), 'bots');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(await page.locator('.workbench').isVisible(), false);
    await selectBot(page, BOT_A); await until(page, '#selected-name', 'Ada');
    assert.equal(await page.locator('body').getAttribute('data-mobile-view'), 'bot');
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('#mobile-back').isVisible(), true);
    await page.locator('#message').fill('A draft for Ada');
    await page.locator('#mobile-back').click(); await selectBot(page, BOT_B); await until(page, '#selected-name', 'Linus');
    assert.equal(await page.locator('#message').inputValue(), '');
    await page.locator('#message').fill('A different draft for Linus');
    await page.locator('#mobile-back').click(); await selectBot(page, BOT_A); await until(page, '#selected-name', 'Ada');
    assert.equal(await page.locator('#message').inputValue(), 'A draft for Ada');
    assert.ok(await page.locator('#mobile-back').evaluate(node => node.getBoundingClientRect().width >= 40 && node.getBoundingClientRect().height >= 40), 'Back has a touch-sized hit target');
    for (const panel of ['conversation', 'computer', 'files', 'apps', 'runs', 'activity']) assert.equal(await page.locator(`#tab-${panel}`).isVisible(), false, 'workspace navigation stays behind its disclosure');
    await page.locator('#more-panels').focus(); await page.keyboard.press('Enter');
    await page.locator('#tab-files').waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tab-files').isVisible(), false);
    assert.equal(await page.locator('#more-panels').evaluate(node => node === document.activeElement), true, 'closing Workspace restores keyboard focus');
    await openPanel(page, 'runs'); await page.locator('#panel-runs').waitFor({state: 'visible'});
    await openPanel(page, 'conversation'); await page.locator('#message').waitFor({state: 'visible'});
    assert.equal(await page.locator('#message').inputValue(), 'A draft for Ada');
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.mobileView === 'bots');
    assert.equal(await page.locator('.sidebar').isVisible(), true, 'browser Back follows the mobile navigation state');
  }, {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
});

test('mobile composer remains visible with a short keyboard-sized viewport and long messages', async () => {
  await withPage(async ({page, login, state}) => {
    state.messages.get(BOT_A).push({id: 'long-mobile-response', botId: BOT_A, role: 'assistant', text: `${'A long result with details.\n\n'.repeat(40)}\n\`\`\`text\n${'a'.repeat(240)}\n\`\`\``, createdAt: new Date().toISOString()});
    await login();
    for (const height of [844, 430]) {
      await page.setViewportSize({width: 390, height});
      await page.locator('#message').fill('A short follow-up'); await page.locator('#message').focus();
      // Browser resize events update the keyboard viewport asynchronously.
      // Wait for that event-driven sizing before asserting the visible layout.
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')) - (window.visualViewport?.height || innerHeight)) <= 1);
      const geometry = await page.evaluate(() => {
        const input = document.querySelector('#message'), composer = document.querySelector('#message-form'), send = composer.querySelector('[type=submit]');
        const rect = node => {const {top, bottom, left, right, height} = node.getBoundingClientRect(); return {top, bottom, left, right, height};};
        return {input: rect(input), composer: rect(composer), send: rect(send), font: parseFloat(getComputedStyle(input).fontSize), viewportHeight: visualViewport?.height || innerHeight, width: innerWidth, pageWidth: document.documentElement.scrollWidth};
      });
      assert.ok(geometry.input.top >= 0 && geometry.input.bottom <= geometry.viewportHeight + 1, `input is visible at ${height}px height: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.send.top >= 0 && geometry.send.bottom <= geometry.viewportHeight + 1, `send is visible above keyboard at ${height}px height`);
      assert.ok(geometry.send.height >= 40, 'Send has a touch-sized hit target');
      assert.ok(geometry.font >= 16, 'composer does not trigger iOS focus zoom');
      assert.ok(geometry.pageWidth <= geometry.width + 1, 'long code scrolls internally without widening the page');
    }
    await sendMessage(page);
    assert.equal(sentMessages(state, BOT_A).length, 1);
  }, {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, colorScheme: 'dark'});
});
