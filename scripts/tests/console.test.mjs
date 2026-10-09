import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN, BOT_A, BOT_B} from './console-fixture.mjs';
import {MODEL_FAILURES} from '../../packages/contracts/src/model-errors.ts';

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
    await until(page, '[data-run-outcome="explicit-stop-run"]', 'Task stopped');
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
    await until(page, '[data-run-outcome="empty-answer-run"]', 'without a visible answer');
    assert.equal(await page.locator('#run-status').isVisible(), false, 'a failed task does not label the bot');
    assert.equal(await page.locator('#run-error').isVisible(), false, 'no duplicate global failure banner');
    const activity = page.locator(`[data-run-activity="${run.id}"]`);
    assert.equal(await activity.locator(`[data-tool-operation-id="${operationId}"][data-tool-status="completed"]`).count(), 1);
    assert.equal(await page.locator('#streaming-message').isVisible(), false); assert.equal(state.messages.get(BOT_A).length, 1, 'no fabricated final response is introduced');
    assert.equal(sentMessages(state, BOT_A).length, 0); assert.equal(state.actions.length, 0);
    assert.equal(await page.getByRole('button', {name: 'Retry sending', exact: true}).count(), 0);
  });
});

test('response recovery is visible and exhausted failure belongs to its task instead of the conversation header', async () => {
  for(const width of [390,1440]) await withPage(async({page,login,state})=>{
    const createdAt=new Date().toISOString(),run={id:'recover-ui-run',botId:BOT_A,operationId:'recover-ui-input',status:'running',createdAt,updatedAt:createdAt};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'recover-ui-message',botId:BOT_A,runId:run.id,role:'user',text:'Revisá la app y explicame el resultado.',createdAt}]);
    state.emit(BOT_A,'tool.completed',{operationId:'recover-ui-exec',toolName:'exec',input:{command:'npm test',timeoutMs:120000},result:{status:'completed',exitCode:0,output:'42 tests passed'}},run.id);
    await login();
    const activity=page.locator('[data-run-activity="recover-ui-run"]');
    state.emit(BOT_A,'message.delta',{delta:'Incomplete response from a lost attempt'},run.id);
    await page.locator('#streaming-text').filter({hasText:'Incomplete response'}).waitFor();
    state.emit(BOT_A,'run.retrying',{attempt:1,maxRetries:2,retryAt:new Date(Date.now()+500).toISOString(),errorCode:'model_connection_interrupted'},run.id);
    await activity.getByRole('status').filter({hasText:'Retrying response · 1/2'}).waitFor();
    assert.equal(await page.locator('#streaming-message').isVisible(),false,'a failed partial cannot concatenate with the next response');
    const error='The model connection was interrupted and could not recover. Your recorded tool results are preserved.';
    run.status='failed';run.error=error;run.updatedAt=new Date(Date.now()+1000).toISOString();state.emit(BOT_A,'run.updated',{run},run.id);
    const notice=page.locator('[data-run-outcome="recover-ui-run"]');
    await notice.filter({hasText:error}).waitFor();
    assert.equal(await page.locator('#run-status').isVisible(),false);
    assert.equal(await page.locator('#run-error').isVisible(),false);
    assert.equal(await page.locator('#messages').getByText(error,{exact:true}).count(),1);
    assert.equal(await notice.evaluate(node=>Boolean(document.querySelector('[data-run-activity="recover-ui-run"]').compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)),true,'the outcome follows the task activity');
    assert.equal(await activity.locator('[data-tool-operation-id="recover-ui-exec"]').getAttribute('data-tool-status'),'completed','a model failure does not rewrite the command outcome');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await notice.scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/task-outcome-${width}.png`,animations:'disabled'});}
    await page.reload();await notice.waitFor();
    assert.equal(await page.locator('#run-status').isVisible(),false,'historical failure stays out of the header after reload');
    await notice.getByRole('button',{name:'Continue',exact:true}).click();
    await page.locator('[data-message-id]').filter({hasText:'Continue this task:'}).waitFor();
    const sent=sentMessages(state,BOT_A);assert.equal(sent.length,1);assert.notEqual(sent[0].body.operationId,run.operationId);
    assert.match(sent[0].body.text,/Revisá la app/);assert.match(sent[0].body.text,/do not repeat completed work/);
    assert.equal(state.actions.length,0,'Continue submits intent, never dispatches an old computer action');
  },{viewport:{width,height:920},colorScheme:'dark'});
});

test('a recovered response finishes the task and leaves the persistent conversation ready',async()=>{
  await withPage(async({page,login,state})=>{
    const createdAt=new Date().toISOString(),run={id:'recover-success',botId:BOT_A,operationId:'recover-success-input',status:'running',createdAt,updatedAt:createdAt};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'recover-success-message',botId:BOT_A,runId:run.id,role:'user',text:'Check the result.',createdAt}]);
    await login();state.emit(BOT_A,'run.retrying',{attempt:1,maxRetries:2,retryAt:createdAt,errorCode:'model_empty_response'},run.id);
    await page.locator('.timber-work-status').filter({hasText:'Retrying response'}).waitFor();
    state.emit(BOT_A,'message.delta',{delta:'The saved result confirms success.'},run.id);
    await page.locator('#streaming-text').filter({hasText:'The saved result confirms success.'}).waitFor();
    const answer={id:'recovered-final',botId:BOT_A,runId:run.id,role:'assistant',kind:'final',text:'The saved result confirms success.',createdAt:new Date(Date.now()+1000).toISOString()};
    state.messages.get(BOT_A).push(answer);state.emit(BOT_A,'message.created',{message:answer},run.id);
    run.status='completed';run.updatedAt=answer.createdAt;state.emit(BOT_A,'run.updated',{run},run.id);
    await page.locator('[data-message-id="recovered-final"]').waitFor();
    assert.equal(await page.locator('#run-status').isVisible(),false);
    assert.equal(await page.locator('[data-run-outcome]').count(),0);
    assert.equal(await page.locator('.timber-work-status').count(),0);
    assert.equal(sentMessages(state,BOT_A).length,0);
  },{viewport:{width:390,height:920},colorScheme:'dark'});
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

for (const status of ['failed','queued']) test(`a ${status} model admission failure retries the original message after settings are corrected`,async()=>{
  await withPage(async({page,login,state})=>{
    state.modelCatalog.models.push({id:'account-fixed',name:'Account fixed',provider:'openai',reasoningEfforts:[],supportsFast:false});
    const stamp=new Date().toISOString(),text=status==='failed'?'':'@Linus Review this image',mentions=text?[BOT_B]:[],attachment={artifactId:'saved-model-input',mimeType:'image/png',size:68};
    const run={id:`model-admission-${status}`,botId:BOT_A,operationId:`model-admission-operation-${status}`,status:'running',model:'gpt-6.1-sol',createdAt:stamp,updatedAt:stamp};
    const message={id:`model-admission-message-${status}`,botId:BOT_A,runId:run.id,role:'user',text,mentions,attachments:[attachment],createdAt:stamp};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[message]);state.messageOperations.set(`${BOT_A}:${run.operationId}`,{text,mentions,run});
    await login();Object.assign(run,{status,admissionRetryable:true,error:'Choose an available model, then retry this message.',updatedAt:new Date(Date.now()+1000).toISOString()});state.emit(BOT_A,'run.updated',{run},run.id);
    const retry=page.getByRole('button',{name:'Retry sending',exact:true});await retry.waitFor();await page.reload();await retry.waitFor();
    assert.equal(sentMessages(state,BOT_A).length,0,'restoring a configuration failure does not resubmit automatically');assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).count(),0);
    await page.locator('#message').fill('Keep my next draft');await page.getByRole('button',{name:/^Model settings:/}).click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true});await settings.getByRole('combobox',{name:'Model',exact:true}).selectOption('account-fixed');await page.getByRole('button',{name:'Model settings: Account fixed',exact:true}).waitFor();await settings.getByRole('button',{name:'Close model settings'}).click();
    await page.route(`**/v1/bots/${BOT_A}/messages`,route=>{if(route.request().method()==='POST'){Object.assign(run,{status:'running',admissionRetryable:false,model:state.bots.find(bot=>bot.id===BOT_A).model,updatedAt:new Date(Date.now()+2000).toISOString()});delete run.error;}return route.continue();});
    await retry.click();await retry.waitFor({state:'hidden'});
    assert.deepEqual(sentMessages(state,BOT_A).map(call=>call.body),[{text,operationId:run.operationId,attachments:[attachment.artifactId],...(mentions.length?{mentions}:{})}]);
    assert.equal(run.model,'account-fixed');assert.equal(state.runs.get(BOT_A).length,1);assert.equal(state.messages.get(BOT_A).length,1);assert.equal(await page.locator(`[data-message-id="${message.id}"]`).count(),1);assert.equal(await page.locator('#message').inputValue(),'Keep my next draft');
    Object.assign(run,{status:'failed',admissionRetryable:false,error:'The model could not complete this request.',updatedAt:new Date(Date.now()+3000).toISOString()});state.emit(BOT_A,'run.updated',{run},run.id);
    await page.getByRole('button',{name:'Try again',exact:true}).waitFor();assert.equal(await retry.count(),0,'a failure after admission cannot replay the original request');
  });
});

test('runtime admission can be retried from a new accepted receipt before history finishes syncing', async () => {
  await withPage(async ({page, login, state}) => {
    await login(); let refresh, first = true;
    state.readsGate = new Promise(resolve => {refresh = resolve;});
    await page.route(`**/v1/bots/${BOT_A}/messages`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!first) {
        // Restore admission only once the retry arrives: a /runs refresh must
        // not remove canRetryAdmission between finding Retry and clicking it.
        delete state.runs.get(BOT_A)[0].error;
        return route.continue();
      }
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
    state.approvals.set(BOT_A, [approval]); await login(); await openPanel(page, 'computer'); await page.locator('#close-workspace').click();
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
    await openPanel(page, 'computer'); await page.locator('#close-workspace').click();
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
    // The saved message mounts a new lazy code renderer. Its trailing prose can
    // appear before that independent code body has finished rendering.
    const expectedCode = 'Linux fixture-kernel\n/workspace\n<img src=x onerror=alert(1)>';
    await page.waitForFunction(expected => document.querySelector('[data-message-id="stream-final"] pre code')?.innerText === expected, expectedCode);
    assert.equal(await page.locator('[data-message-id="stream-final"]').count(), 1); assert.equal(await page.locator('[data-message-id="stream-final"] pre code').innerText(), expectedCode);
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

for (const viewport of [{width:1440,height:1000},{width:1024,height:768},{width:820,height:1180},{width:768,height:1024}]) test(`conversation and workspace remain usable together at ${viewport.width}px`, async()=>{
  await withPage(async({page,login})=>{
    await login();
    await page.locator('#message').fill('Keep this draft while browsing');
    await page.locator('#toggle-workspace').click();
    await page.locator('#panel-computer').waitFor({state:'visible'});
    const chat=await page.locator('#panel-conversation').boundingBox(),right=await page.locator('#workspace-sidebar').boundingBox();
    assert.ok(chat.width>=360 && right.width>=320 && chat.x+chat.width<=right.x+1,'chat and workspace fit side by side');
    await page.locator('.inspector-tabs [data-panel="apps"]').click();
    assert.equal(await page.locator('#panel-conversation').isVisible(),true);
    assert.equal(await page.locator('#panel-apps').isVisible(),true);
    assert.equal(await page.locator('#message').inputValue(),'Keep this draft while browsing');
    if(await page.locator('#bot-sidebar').isVisible()) await page.locator('#toggle-bots').click();
    assert.equal(await page.locator('#bot-sidebar').isVisible(),false);
    await page.locator('#toggle-bots').click();
    assert.equal(await page.locator('#bot-sidebar').isVisible(),true);
    if(viewport.width<1100){await page.locator('#sidebar-scrim').click({position:{x:viewport.width-50,y:70}});}
    else await page.locator('#toggle-bots').click();
    assert.equal(await page.locator('#panel-apps').isVisible(),true);
    await page.locator('#close-workspace').click();
    assert.equal(await page.locator('#workspace-sidebar').isVisible(),false);
    await page.locator('#toggle-workspace').click();
    assert.equal(await page.locator('#panel-apps').isVisible(),true,'reopening restores the selected workspace tab');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const prompt=await page.locator('#message').boundingBox();assert.ok(prompt.y+prompt.height<=viewport.height,'composer stays on screen');
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/panels-${viewport.width}.png`});}
    await page.reload();await page.locator('#app').waitFor({state:'visible'});await page.locator('#panel-apps').waitFor({state:'visible'});
    assert.equal(await page.locator('#bot-sidebar').isVisible(),false,'sidebar preference survives a reload');
    assert.equal(await page.locator('#panel-conversation').isVisible(),true);
  },{viewport,colorScheme:'dark'});
});

test('live activity follows its accepted request before transcript sync even when the device clock is ahead',async()=>{
  await withPage(async({page,login,state})=>{
    await login();await page.clock.setFixedTime(new Date('2035-01-01T12:00:00Z'));
    let run;
    await page.route(`**/v1/bots/${BOT_A}/messages`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const input=route.request().postDataJSON();
      const now=new Date().toISOString();
      run={id:'order-pending-run',botId:BOT_A,operationId:input.operationId,status:'running',createdAt:now,updatedAt:now};
      state.runs.get(BOT_A).unshift(run);
      await route.fulfill({status:202,json:{run}});
    });
    await page.locator('#message').fill('Build the app after this message');await sendMessage(page);
    await page.locator('.timber-delivery-status').filter({hasText:'Running'}).waitFor();
    state.emit(BOT_A,'tool.started',{toolCallId:'order-pending-tool',toolName:'exec',input:{command:'npm run build'}},run.id);
    await page.locator('[data-run-activity="order-pending-run"]').waitFor();
    const ordered=await page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-operation-id], [data-run-activity]')].map(item=>item.dataset.operationId || item.dataset.runActivity));
    assert.deepEqual(ordered,[run.operationId,run.id],'the accepted bubble anchors its activity even before its stored message exists');
    const message={id:'order-stored-user',botId:BOT_A,runId:run.id,role:'user',text:'Build the app after this message',createdAt:run.createdAt};
    state.messages.get(BOT_A).push(message);
    state.emit(BOT_A,'message.created',{message},run.id);
    await page.locator('[data-message-id="order-stored-user"]').waitFor();
    assert.equal(await page.locator(`[data-operation-id="${run.operationId}"]`).count(),0,'reconciliation leaves one request bubble');
    const finalOrder=await page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-message-id="order-stored-user"], [data-run-activity]')].map(item=>item.dataset.messageId || item.dataset.runActivity));
    assert.deepEqual(finalOrder,['order-stored-user',run.id]);
  });
});

test('streamed requests and answers render immediately and survive an older in-flight transcript snapshot',async()=>{
  await withPage(async({page,login,state})=>{
    await login();const snapshot=structuredClone(state.messages.get(BOT_A));
    let release,started;const gate=new Promise(resolve=>release=resolve),readStarted=new Promise(resolve=>started=resolve);
    let held=false;
    await page.route(`**/v1/bots/${BOT_A}/messages`,async route=>{
      if(route.request().method()!=='GET')return route.continue();
      if(!held){held=true;started();await gate;}
      await route.fulfill({json:{messages:snapshot}});
    });
    const now=new Date().toISOString(),run={id:'order-stream-run',botId:BOT_A,operationId:'order-stream-op',status:'running',createdAt:now,updatedAt:now};
    state.runs.get(BOT_A).unshift(run);state.emit(BOT_A,'run.updated',{run},run.id);
    await readStarted;
    const message={id:'order-stream-user',botId:BOT_A,runId:run.id,role:'user',text:'This request arrived in the live stream',createdAt:now};
    const reply={id:'order-stream-answer',botId:BOT_A,runId:run.id,role:'assistant',text:'The live answer is ready',createdAt:new Date().toISOString()};
    try{
      state.emit(BOT_A,'message.created',{message},run.id);
      state.emit(BOT_A,'tool.started',{toolCallId:'order-stream-tool',toolName:'exec',input:{command:'pwd'}},run.id);
      state.emit(BOT_A,'message.created',{message:reply},run.id);
      await page.locator('[data-message-id="order-stream-answer"]').waitFor();
      const order=await page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-message-id^="order-stream"], [data-run-activity]')].map(item=>item.dataset.messageId||item.dataset.runActivity));
      assert.ok(order.indexOf(message.id)<order.indexOf(run.id));
      assert.ok(order.indexOf(message.id)<order.indexOf(reply.id));
      const read=page.waitForResponse(response=>response.url().endsWith('/messages'));release();await read;
      assert.equal(await page.locator('[data-message-id="order-stream-user"]').count(),1);
      assert.equal(await page.locator('[data-message-id="order-stream-answer"]').count(),1);
      state.emit(BOT_A,'message.created',{message:{...message,id:'foreign-stream-user',botId:BOT_B}},run.id);
      await openPanel(page,'activity');await page.locator('#refresh-history').click();await openPanel(page,'conversation');
      assert.equal(await page.locator('[data-message-id="foreign-stream-user"]').count(),0);
      assert.equal(await page.locator('[data-message-id="order-stream-user"]').count(),1,'stale refresh cannot remove the request anchor');
      await selectBot(page,BOT_B);await until(page,'#selected-name','Linus');
      assert.equal(await page.locator('[data-message-id="order-stream-user"]').count(),0,'stream cache is isolated to its bot');
    }finally{release();}
  });
});

test('historical approvals and activity cannot precede their own request despite earlier timestamps',async()=>{
  await withPage(async({page,login,state})=>{
    const approval=pendingApproval(),later='2035-01-01T12:00:00Z';
    state.approvals.set(BOT_A,[approval]);
    state.messages.set(BOT_A,[{id:'causal-user',botId:BOT_A,runId:approval.runId,role:'user',text:'Inspect the workspace',createdAt:later}]);
    state.emit(BOT_A,'tool.started',{toolCallId:'causal-tool',toolName:'list_files',input:{path:'.'}},approval.runId);
    await login();await page.locator('[data-run-activity]').waitFor();
    const order=await page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-message-id], [data-timeline-approval], [data-run-activity]')].map(item=>item.dataset.messageId||item.dataset.timelineApproval||item.dataset.runActivity));
    assert.equal(order[0],'causal-user');assert.ok(order.includes(approval.id));assert.ok(order.includes(approval.runId));
  });
});

for (const width of [390,1440]) test(`assistant replies separate successive activity blocks in live and saved history at ${width}px`,async()=>{
  await withPage(async({page,login,state})=>{
    const at=second=>new Date(Date.parse('2026-10-08T12:00:00Z')+second*1000).toISOString();
    const run={id:'interleaved-run',botId:BOT_A,operationId:'interleaved-op',status:'running',createdAt:at(0),updatedAt:at(0)};
    const user={id:'interleaved-user',botId:BOT_A,runId:run.id,role:'user',text:'Volver a levantar Spacetime',createdAt:at(0)};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[user]);
    const emit=(type,data,second)=>{
      const event={id:++state.nextEventId,botId:BOT_A,runId:run.id,type,data,createdAt:at(second)};
      state.events.push(event);state.deliver(event);
    };
    const message=(id,text,second,kind='progress')=>{
      const value={id,botId:BOT_A,runId:run.id,role:'assistant',kind,text,createdAt:at(second)};
      state.messages.get(BOT_A).push(value);emit('message.created',{message:value},second);return value;
    };
    const start=(id,command,second)=>emit('tool.started',{toolCallId:id,toolName:'exec',input:{command}},second);
    const finish=(id,second)=>emit('tool.completed',{toolCallId:id,toolName:'exec',result:{status:'completed',output:'ok',exitCode:0}},second);
    const order=()=>page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-message-id], [data-tool-operation-id]')].map(item=>item.dataset.messageId||item.dataset.toolOperationId));
    start('interleaved-inspect','command -v bun',1);finish('interleaved-inspect',2);
    await login();await page.locator('[data-tool-operation-id="interleaved-inspect"]').waitFor();
    message('interleaved-reply','Sí, estoy restaurando las dependencias y volviendo a arrancar Spacetime.',3);
    await page.locator('[data-message-id="interleaved-reply"]').waitFor();
    start('interleaved-install','npm install',4);
    await page.locator('[data-tool-operation-id="interleaved-install"]').waitFor();
    assert.deepEqual(await order(),[user.id,'interleaved-inspect','interleaved-reply','interleaved-install'],'new activity follows the public assistant reply');
    assert.equal(await page.locator('[data-message-id="interleaved-reply"]').evaluate(node=>node.closest('[data-run-activity]')),null,'the reply remains a normal assistant message');
    assert.equal(await page.locator('[data-run-activity]').count(),2);
    await page.locator('[data-tool-operation-id="interleaved-install"] > summary').click();
    finish('interleaved-install',5);
    message('interleaved-launch-reply','Las dependencias están listas. Ahora arranco la app.',6);
    start('interleaved-launch','npm run dev',7);start('interleaved-check','curl -I http://localhost:3000',8);
    await page.locator('[data-tool-operation-id="interleaved-check"]').waitFor();
    assert.equal(await page.locator('[data-tool-operation-id="interleaved-install"]').evaluate(node=>node.open),true,'later replies do not remount previously opened action details');
    assert.equal(await page.locator('[data-run-activity]').count(),3,'consecutive actions share a block until another message');
    assert.equal(await page.locator('[data-run-activity]').first().locator('.timber-activity-status').count(),0,'finished earlier blocks do not claim to be working');
    finish('interleaved-launch',9);finish('interleaved-check',10);
    message('interleaved-final','Spacetime está disponible.',11,'final');
    run.status='completed';run.updatedAt=at(11);emit('run.updated',{run},11);
    await page.locator('[data-message-id="interleaved-final"]').waitFor();
    const expected=[user.id,'interleaved-inspect','interleaved-reply','interleaved-install','interleaved-launch-reply','interleaved-launch','interleaved-check','interleaved-final'];
    assert.deepEqual(await order(),expected);
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.locator('[data-message-id="interleaved-reply"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/interleaved-${width}.png`});}
    await page.reload();await page.locator('[data-tool-operation-id="interleaved-check"]').waitFor();
    assert.deepEqual(await order(),expected,'reloading restores the same interleaved conversation');
    assert.equal(await page.locator('[data-run-activity]').count(),3);
    assert.equal(state.calls.some(call=>call.method!=='GET'),false,'rendering history does not replay actions');
  },{viewport:{width,height:1000},colorScheme:'dark'});
});

for(const delay of [0,1000]) test(`a progress reply precedes activity and its same-time final answer with ${delay}ms delay`,async()=>{
  await withPage(async({page,login,state})=>{
    const at='2026-10-08T12:00:00Z',runId='tie-progress-run';
    const toolAt=new Date(Date.parse(at)+delay).toISOString();
    state.runs.set(BOT_A,[{id:runId,botId:BOT_A,operationId:'tie-progress-op',status:'completed',createdAt:at,updatedAt:at}]);
    state.messages.set(BOT_A,[
      {id:'tie-progress-user',botId:BOT_A,runId,role:'user',text:'Arrancá la app.',createdAt:at},
      {id:'tie-progress-reply',botId:BOT_A,runId,role:'assistant',kind:'progress',text:'Sí, estoy arrancando la app.',createdAt:at},
      {id:'tie-progress-final',botId:BOT_A,runId,role:'assistant',kind:'final',text:'La app está disponible.',createdAt:toolAt},
    ]);
    state.emit(BOT_A,'tool.started',{toolCallId:'tie-progress-tool',toolName:'exec',input:{command:'npm run dev'}},runId).createdAt=toolAt;
    state.emit(BOT_A,'tool.completed',{toolCallId:'tie-progress-tool',toolName:'exec',result:{status:'completed',output:'Ready',exitCode:0}},runId).createdAt=toolAt;
    await login();await page.locator('[data-tool-operation-id="tie-progress-tool"]').waitFor();
    const order=await page.locator('#messages').evaluate(node=>[...node.querySelectorAll('[data-message-id], [data-tool-operation-id]')].map(item=>item.dataset.messageId||item.dataset.toolOperationId));
    assert.deepEqual(order,['tie-progress-user','tie-progress-reply','tie-progress-tool','tie-progress-final']);
  });
});

for(const width of [390,1440]) test(`screenshot actions show authenticated expandable thumbnails at ${width}px`,async()=>{
  await withPage(async({page,login,state})=>{
    const artifactId='10000000-0000-4000-8000-000000000099';
    state.messages.set(BOT_A,[]);
    state.emit(BOT_A,'tool.completed',{operationId:'screenshot-action',toolName:'desktop_screenshot',result:{status:'completed',artifactId,mimeType:'image/png'}},'screenshot-run');
    await login();
    const thumb=page.getByRole('button',{name:'Expand screenshot',exact:true});
    await thumb.waitFor();await page.waitForFunction(()=>document.querySelector('[data-artifact-id] img')?.naturalWidth===1280);
    assert.equal(await page.locator('[data-tool-operation-id="screenshot-action"]').evaluate(node=>node.open),false,'a thumbnail needs no action disclosure');
    assert.equal(state.actions.length,0,'preview reads the saved artifact without taking another screenshot');
    assert.equal(state.calls.filter(call=>call.path===`/v1/bots/${BOT_A}/artifacts/${artifactId}`).length,1);
    await thumb.click();const dialog=page.getByRole('dialog',{name:'Screenshot',exact:true});await dialog.waitFor();
    assert.equal(await page.locator('[data-tool-operation-id="screenshot-action"]').evaluate(node=>node.open),false,'opening an image does not also toggle action details');
    assert.equal(await dialog.locator('img').evaluate(img=>img.naturalWidth),1280);
    await dialog.getByRole('button',{name:'View actual size',exact:true}).click();
    assert.equal(await dialog.locator('.is-zoomed img').evaluate(img=>img.getBoundingClientRect().width),1280);
    await dialog.getByRole('button',{name:'Fit image',exact:true}).click();
    assert.ok((await dialog.locator('img').boundingBox()).width<=width);
    const download=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download screenshot',exact:true}).click();
    assert.equal((await download).suggestedFilename(),`screenshot-${artifactId}.png`);
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/screenshot-dialog-${width}.png`});}
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await thumb.evaluate(node=>node===document.activeElement),true,'closing restores focus to the thumbnail');
    await openPanel(page,'activity');await page.locator('#activity-tools').getByRole('button',{name:'Expand screenshot',exact:true}).waitFor();
    assert.equal(state.actions.length,0);
  },{viewport:{width,height:900},colorScheme:'dark'});
});

test('screenshot previews discard late reads on bot changes and release image URLs on sign-out',async()=>{
  await withPage(async({page,login,state})=>{
    const artifactId='10000000-0000-4000-8000-000000000099';
    await page.addInitScript(()=>{
      window.__artifactURLs={created:[],revoked:[]};
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);window.__artifactURLs.created.push(url);return url;};
      URL.revokeObjectURL=url=>{window.__artifactURLs.revoked.push(url);revoke(url);};
    });
    state.messages.set(BOT_A,[]);
    state.emit(BOT_A,'tool.completed',{operationId:'private-image',toolName:'desktop_screenshot',result:{status:'completed',artifactId}},'image-run');
    let release,finish;
    const gate=new Promise(resolve=>release=resolve),finished=new Promise(resolve=>finish=resolve);
    const routePattern=`**/artifacts/${artifactId}`;
    await page.route(routePattern,async route=>{await gate;try{await route.continue();}finally{finish();}});
    try {
      const requested=page.waitForRequest(request=>request.url().endsWith(`/artifacts/${artifactId}`));
      await login();await requested;
      await selectBot(page,BOT_B);await until(page,'#selected-name','Linus');
      release();await finished;await page.unroute(routePattern);
      assert.equal(await page.locator('[data-artifact-id]').count(),0);
      assert.deepEqual(await page.evaluate(()=>window.__artifactURLs.created),[],'a late response cannot create an image in another bot');
      await selectBot(page,BOT_A);await page.getByRole('button',{name:'Expand screenshot',exact:true}).waitFor();
      assert.ok(await page.evaluate(()=>window.__artifactURLs.created.length)>0);
      await signOut(page);await page.locator('#login').waitFor({state:'visible'});
      await page.waitForFunction(()=>window.__artifactURLs.created.every(url=>window.__artifactURLs.revoked.includes(url)));
      assert.equal(await page.locator('[data-artifact-id]').count(),0);
      assert.equal(state.actions.length,0);
    } finally {release();}
  });
});

test('completed activity survives a long conversation, later actions and reload',async()=>{
  await withPage(async({page,login,state})=>{
    const createdAt=new Date().toISOString();
    const run={id:'retained-activity-run',botId:BOT_A,operationId:'retained-request',status:'running',createdAt,updatedAt:createdAt};
    state.runs.set(BOT_A,[run]);
    state.messages.set(BOT_A,[{id:'retained-user',botId:BOT_A,runId:run.id,role:'user',text:'Inspect the workspace.',createdAt}]);
    state.emit(BOT_A,'tool.started',{operationId:'retained-command',toolName:'exec',input:{command:'pwd'}},run.id);
    state.emit(BOT_A,'tool.completed',{operationId:'retained-command',toolName:'exec',result:{status:'completed',output:'/workspace',exitCode:0}},run.id);
    await login();await page.locator('[data-tool-operation-id="retained-command"]').waitFor();
    // Host and native events can exceed the diagnostic log's 200 entries in
    // ordinary long conversations. That cap must never trim transcript actions.
    for(let i=0;i<105;i++){
      state.emit(BOT_A,'tool.started',{operationId:`later-key-${i}`,toolName:'desktop_key',input:{key:'Escape'}},run.id);
      state.emit(BOT_A,'tool.completed',{operationId:`later-key-${i}`,toolName:'desktop_key',result:{status:'completed',output:'key submitted to desktop'}},run.id);
    }
    const answer={id:'retained-answer',botId:BOT_A,runId:run.id,role:'assistant',kind:'final',text:'Workspace inspection complete.',createdAt:new Date().toISOString()};
    state.messages.get(BOT_A).push(answer);state.emit(BOT_A,'message.created',{message:answer},run.id);
    run.status='completed';run.updatedAt=answer.createdAt;state.emit(BOT_A,'run.updated',{run},run.id);
    await page.locator('[data-tool-operation-id="later-key-104"][data-tool-status="completed"]').waitFor();
    await page.locator('[data-message-id="retained-answer"]').waitFor();
    assert.equal(await page.locator('[data-tool-operation-id="retained-command"]').count(),1,'finishing newer actions must not remove completed history');
    assert.equal((await page.locator('[data-tool-operation-id="retained-command"] [data-tool-result-preview]').innerText()).trim(),'/workspace');
    await page.reload();await page.locator('[data-tool-operation-id="later-key-104"]').waitFor();
    assert.equal(await page.locator('[data-tool-operation-id="retained-command"]').count(),1,'SSE replay restores the complete activity history');
    assert.equal(await page.locator('[data-tool-operation-id]').count(),106,'replay does not duplicate actions');
    assert.equal(await page.locator('#activity-list > article').count(),200,'the separate diagnostic log stays bounded');
  });
});

test('an unavailable screenshot offers a read-only retry and never hides meaningful tool output',async()=>{
  await withPage(async({page,login,state})=>{
    const artifactId='10000000-0000-4000-8000-000000000099';let reads=0;
    await page.route(`**/artifacts/${artifactId}`,route=>++reads===1?route.fulfill({status:503,json:{error:{message:'Image temporarily unavailable'}}}):route.continue());
    state.messages.set(BOT_A,[]);
    for(const [id,toolName,output,status] of [['quiet-key','desktop_key','key submitted to desktop','completed'],['quiet-click','desktop_click','click submitted to desktop','completed'],['useful-exec','exec','key submitted to desktop','completed'],['failed-key','desktop_key','key submitted to desktop','failed']]){
      state.emit(BOT_A,'tool.completed',{operationId:id,toolName,input:{key:'Escape',command:'npm run build',x:20,y:30},result:{status,output}},'image-run');
    }
    state.emit(BOT_A,'tool.completed',{operationId:'retry-image',toolName:'desktop_screenshot',result:{status:'completed',artifactId}},'image-run');
    await login();await page.getByRole('button',{name:'Retry screenshot preview',exact:true}).waitFor();
    assert.equal(await page.locator('[data-tool-operation-id="quiet-key"] [data-tool-result-preview]').count(),0);
    assert.equal(await page.locator('[data-tool-operation-id="quiet-click"] [data-tool-result-preview]').count(),0);
    assert.match(await page.locator('[data-tool-operation-id="useful-exec"] [data-tool-result-preview]').innerText(),/key submitted to desktop/);
    assert.match(await page.locator('[data-tool-operation-id="failed-key"] [data-tool-result-preview]').innerText(),/key submitted/);
    await page.getByRole('button',{name:'Retry screenshot preview',exact:true}).click();
    await page.getByRole('button',{name:'Expand screenshot',exact:true}).waitFor();
    assert.equal(reads,2);assert.equal(state.actions.length,0);
    assert.equal(await page.getByRole('dialog',{name:'Screenshot',exact:true}).count(),0,'retrying an image does not open an empty viewer');
    await page.locator('[data-tool-operation-id="quiet-key"] > summary').click();
    assert.match(await page.locator('[data-tool-operation-id="quiet-key"] .timber-tool-output').innerText(),/key submitted to desktop/,'raw output remains inspectable');
  });
});

for (const width of [390,820]) test(`focused composer follows the keyboard viewport when it pans at ${width}px`,async()=>{
  await withPage(async({page,login,state})=>{
    state.messages.get(BOT_A).push({id:'keyboard-history',botId:BOT_A,role:'assistant',text:'Earlier context.\n\n'.repeat(80),createdAt:new Date().toISOString()});
    await page.addInitScript(()=>{
      const viewport=window.visualViewport;
      const initial={height:844,offsetTop:0,scale:1};
      window.__keyboardViewport=initial;
      for(const key of Object.keys(initial))Object.defineProperty(viewport,key,{configurable:true,get:()=>window.__keyboardViewport[key]});
    });
    await login();await page.locator('#message').fill('Volver a levantar');await page.locator('#message').focus();
    // Keep the layout viewport full size. iOS can pan and shrink only the
    // visual viewport, including scroll events with no corresponding resize.
    for(const [height,offsetTop,event] of [[430,320,'resize'],[430,370,'scroll'],[430,285,'scroll'],[390,285,'resize'],[844,0,'resize']]){
      await page.evaluate(({height,offsetTop,event})=>{Object.assign(window.__keyboardViewport,{height,offsetTop});visualViewport.dispatchEvent(new Event(event));},{height,offsetTop,event});
      await page.waitForFunction(()=>{
        const box=document.querySelector('#message-form').getBoundingClientRect();
        const bottom=box.bottom-visualViewport.offsetTop;
        return bottom<=visualViewport.height+1 && bottom>=visualViewport.height-24;
      });
      const geometry=await page.evaluate(()=>{
        const offset=visualViewport.offsetTop,box=node=>{const r=node.getBoundingClientRect();return {top:r.top-offset,bottom:r.bottom-offset,height:r.height};};
        return {prompt:box(document.querySelector('#message-form')),header:box(document.querySelector('.bot-header')),viewport:visualViewport.height,inputFocused:document.activeElement===document.querySelector('#message'),pageWidth:document.documentElement.scrollWidth,width:innerWidth};
      });
      assert.ok(geometry.header.top>=-1,'the header stays in view when the browser pans');
      assert.ok(geometry.prompt.bottom<=geometry.viewport+1 && geometry.prompt.bottom>=geometry.viewport-24,'the prompt remains immediately above the keyboard, not merely somewhere on screen');
      assert.equal(geometry.inputFocused,true,'viewport updates do not blur the composer');
      assert.ok(geometry.pageWidth<=geometry.width+1);
      if(process.env.CONSOLE_SCREENSHOT_DIR && offsetTop===320){
        await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/keyboard-${width}.png`,clip:{x:0,y:offsetTop,width,height}});
      }
    }
    await page.locator('#message').press('Shift+Enter');await page.locator('#message').pressSequentially('Conserva el borrador');
    assert.equal(await page.locator('#message').inputValue(),'Volver a levantar\nConserva el borrador');
    const draft=await page.locator('#message').inputValue(),input=page.locator('#message');
    const small=(await input.boundingBox()).height;
    await input.fill('Una línea de texto\n'.repeat(12));
    const tall=(await input.boundingBox()).height;
    assert.ok(tall>small && tall<=160,'the prompt grows for multiple lines without exceeding its height limit');
    await input.fill(draft);
    assert.equal((await input.boundingBox()).height,small,'deleting lines restores the prompt height');
    const beforeZoom=await page.locator('#message-form').boundingBox();
    await page.evaluate(()=>{Object.assign(window.__keyboardViewport,{height:400,offsetTop:120,scale:2});visualViewport.dispatchEvent(new Event('resize'));});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await page.locator('#message-form').boundingBox(),beforeZoom,'pinch zoom does not reflow the chat around the zoomed viewport');
    await page.evaluate(()=>{Object.assign(window.__keyboardViewport,{height:844,offsetTop:0,scale:1});visualViewport.dispatchEvent(new Event('resize'));});
    const messages=page.locator('#messages');await messages.evaluate(node=>{node.scrollTop=120;});
    await page.locator('#message').blur();
    await page.evaluate(()=>{visualViewport.dispatchEvent(new Event('scroll'));});
    assert.ok(Math.abs(await messages.evaluate(node=>node.scrollTop)-120)<2,'viewport synchronization does not reset a reviewed conversation');
    await sendMessage(page);assert.equal(sentMessages(state,BOT_A).length,1);
    await openBotEditor(page);await page.locator('#edit-name').focus();
    await page.evaluate(()=>{Object.assign(window.__keyboardViewport,{height:430,offsetTop:320});visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>{
      const box=document.querySelector('#edit-dialog').getBoundingClientRect(),offset=visualViewport.offsetTop;
      return box.top>=offset && box.bottom<=offset+visualViewport.height;
    });
    assert.equal(await page.locator('#edit-name').evaluate(node=>document.activeElement===node),true,'a modal field stays focused and its dialog fits above the keyboard');
  },{viewport:{width,height:844},isMobile:true,hasTouch:true,colorScheme:'dark'});
});

test('named agents permission defaults off and persists through bot editing and creation', async () => {
  await withPage(async ({page,state,login}) => {
    await login(); await openBotEditor(page);
    assert.equal(await page.locator('#edit-allow-named-agents').isChecked(), false);
    await page.locator('#edit-allow-named-agents').check();await page.locator('#edit-form [type=submit]').click();
    await page.locator('#edit-dialog').waitFor({state:'hidden'});
    assert.equal(state.bots.find(bot=>bot.id===BOT_A).allowNamedAgents,true);
    await page.reload();await page.locator('#message').waitFor();await openBotEditor(page);
    assert.equal(await page.locator('#edit-allow-named-agents').isChecked(),true);
    await page.locator('[data-close-dialog="edit-dialog"]').first().click();await page.locator('#new-bot').click();
    assert.equal(await page.locator('#bot-allow-named-agents').isChecked(),false);
    await page.locator('#bot-name').fill('Lead');await page.locator('#bot-allow-named-agents').check();await page.locator('#create-form [type=submit]').click();
    await until(page,'#selected-name','Lead');assert.equal(state.bots.find(bot=>bot.name==='Lead').allowNamedAgents,true);
  });
});

test('bot mentions select explicit IDs with spaces and duplicate names and remove edited recipients', async () => {
  await withPage(async ({page,state,login}) => {
    state.bots.find(bot=>bot.id===BOT_B).name='Code Reviewer';
    const duplicate={...state.bots[1],id:'10000000-0000-4000-8000-000000000088'};state.bots.push(duplicate);
    await login();await page.locator('#message').fill('@Code');
    await page.locator(`[data-mention-bot="${BOT_B}"]`).waitFor();
    assert.match(await page.locator(`[data-mention-bot="${BOT_B}"]`).innerText(),new RegExp(BOT_B.slice(-8)));
    await page.locator(`[data-mention-bot="${BOT_B}"]`).click();
    assert.equal(await page.locator('#message').inputValue(),'@Code Reviewer ');
    await page.locator('#message').pressSequentially('please review this');await sendMessage(page);
    await page.waitForFunction(()=>!document.querySelector('#message').value);
    assert.deepEqual(sentMessages(state,BOT_A).at(-1).body.mentions,[BOT_B]);
    await page.locator('#message').fill('@Code');await page.locator(`[data-mention-bot="${duplicate.id}"]`).click();
    await page.locator('#message').fill('@Code ReviewerExtra please check');
    assert.equal(await page.locator('.timber-selected-mentions').count(),0,'extending the selected name removes its recipient instead of sending to the old bot');
    await page.locator('#message').fill('Different request without a mention');
    assert.equal(await page.locator('.timber-selected-mentions').count(),0);await sendMessage(page);
    await page.waitForFunction(()=>!document.querySelector('#message').value);
    assert.equal(sentMessages(state,BOT_A).at(-1).body.mentions,undefined);
  });
});

test('bot mention keyboard selection and unknown-delivery retry retain identical recipients and operation ID', async () => {
  await withPage(async ({page,state,login}) => {
    await login();let rejected=false;const submissions=[];
    await page.route(`**/v1/bots/${BOT_A}/messages`,async route=>{
      if(route.request().method()!=='POST') return route.continue();
      submissions.push(route.request().postDataJSON());
      if(!rejected){rejected=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'unavailable',message:'Temporary connection issue.'}})});}
      return route.continue();
    });
    await page.locator('#message').fill('@Lin');
    // Typing can arrive before the next animation frame on a busy device. Hold
    // that frame so inserting a mention cannot later rewind the user's cursor.
    await page.evaluate(()=>{
      const original=window.requestAnimationFrame,pending=[];
      window.requestAnimationFrame=callback=>{pending.push(callback);return -pending.length;};
      window.__releaseMentionFrame=()=>{window.requestAnimationFrame=original;for(const callback of pending)callback(performance.now());delete window.__releaseMentionFrame;};
    });
    await page.locator('#message').press('Enter');
    assert.equal(await page.locator('#message').inputValue(),'@Linus ');
    await page.locator('#message').pressSequentially('c');
    await page.evaluate(()=>window.__releaseMentionFrame());
    await page.locator('#message').pressSequentially('heck this');await sendMessage(page);
    await page.getByRole('button',{name:'Retry sending',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#message').value);
    assert.equal(submissions.length,2);assert.equal(submissions[0].text,'@Linus check this');assert.deepEqual(submissions[0],submissions[1]);assert.deepEqual(submissions[1].mentions,[BOT_B]);
    assert.equal(state.messages.get(BOT_A).filter(message=>message.text==='@Linus check this').length,1);
  });
});

for (const viewport of [{width:1440,height:1050},{width:390,height:844}]) test(`temporary agents show conversations, messages, cancellation and reload persistence at ${viewport.width}px`, async () => {
  await withPage(async ({page,state,login}) => {
    const stamp=new Date().toISOString(),agent={id:'child-research',name:'Researcher',task:'Review the project architecture',parentOperationId:'parent-operation',operationId:'child-operation',status:'running',createdAt:stamp,updatedAt:stamp};
    state.agents.set(BOT_A,[agent]);state.agentMessages.set(agent.id,[{id:'child-response',role:'assistant',text:'The architecture review is underway.',createdAt:stamp}]);
    state.runs.set(BOT_A,[{id:'child-run',botId:BOT_A,operationId:agent.operationId,subagentId:agent.id,parentRunId:'parent-run',status:'running',createdAt:stamp,updatedAt:stamp}]);
    await login();assert.equal(await page.locator('#run-status').isVisible(),false,'child activity has its own status and does not replace the parent header');await page.locator('[data-chat-agent="child-research"]').click();
    await page.locator('[data-agent-detail="child-research"]').waitFor();await page.getByText('The architecture review is underway.',{exact:true}).waitFor();
    await page.locator('#agent-message').fill('Also review persistence');await page.getByRole('button',{name:'Send message to Researcher',exact:true}).click();
    await page.getByText('Also review persistence',{exact:true}).waitFor();
    assert.equal(state.agentMessageOperations.size,1);assert.equal(new URL(page.url()).hash.includes('agent=child-research'),true);
    state.emit(BOT_A,'subagent.tool.completed',{subagentId:agent.id,toolCallId:'child-tool',toolName:'read_file',result:{status:'completed',output:'Public tool result'}});
    await page.locator('.timber-agent-activity summary').click();await page.getByText('Public tool result',{exact:true}).waitFor();
    state.emit(BOT_A,'tool.completed',{subagentId:agent.id,operationId:'child-effect',toolCallId:'child-tool',toolName:'read_file',result:{status:'completed',output:'Public tool result'}});
    await page.locator('.timber-agent-activity summary').filter({hasText:'Tool activity · 1'}).waitFor();
    assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0,'child tool output never appears as a parent tool');
    await page.reload();await page.locator('[data-agent-detail="child-research"]').waitFor();await page.getByText('Also review persistence',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Stop agent',exact:true}).click();
    await page.locator('.timber-agent-detail-heading [data-status="cancelled"]').waitFor();
    assert.equal(await page.locator('#agent-message').count(),0,'cancelled agents retain history without accepting more work');
    const box=await page.locator('#agents-root').boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=viewport.width+1);
    await page.getByRole('button',{name:'Back to agents',exact:true}).click();await page.locator('[data-agent-id="child-research"]').waitFor();
    assert.equal(agent.status,'cancelled');
  },{viewport,...(viewport.width<760?{isMobile:true,hasTouch:true}:{})});
});

test('bot collaboration shows source identity and opens the target conversation', async () => {
  await withPage(async ({page,state,login}) => {
    state.bots.find(bot=>bot.id===BOT_B).createdByBotId=BOT_A;
    const stamp=new Date().toISOString();state.delegations.set(BOT_A,[{id:'delegation-one',sourceBotId:BOT_A,sourceBotName:'Ada',sourceRunId:'source-run',targetBotId:BOT_B,targetBotName:'Linus',path:[BOT_A,BOT_B],status:'completed',createdAt:stamp,updatedAt:stamp}]);
    state.messages.get(BOT_A).push({id:'collaboration-result',botId:BOT_A,role:'user',text:'The software review is complete.',provenance:{kind:'delegation_result',sourceBotId:BOT_B,sourceBotName:'Linus',delegationId:'delegation-one'},createdAt:stamp});
    await login();await page.locator('[data-message-id="collaboration-result"] .timber-agent-source').filter({hasText:'Linus'}).waitFor();
    await openPanel(page,'agents');await page.locator('[data-delegation-id="delegation-one"]').waitFor();
    await page.locator(`[data-named-agent="${BOT_B}"]`).filter({hasText:'Persistent bot'}).waitFor();
    await page.getByRole('button',{name:'Open Linus',exact:true}).click();await until(page,'#selected-name','Linus');
  });
});

test('agent controls and mention selection remain available in expanded computer chat', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp=new Date().toISOString();state.agents.set(BOT_A,[{id:'child-docked',name:'Reviewer',task:'Review changes',parentOperationId:'parent',operationId:'child',status:'running',createdAt:stamp,updatedAt:stamp}]);
    state.agentMessages.set('child-docked',[{id:'docked-message',role:'assistant',text:'Review in progress.',createdAt:stamp}]);
    await login();await openPanel(page,'computer');await page.locator('#expand-workspace').click();
    await page.locator('#desktop-chat-dock #message').waitFor();await page.locator('#message').fill('@Lin');
    await page.locator(`[data-mention-bot="${BOT_B}"]`).waitFor();await page.locator('#message').press('Enter');
    await page.locator('#desktop-chat-dock .timber-selected-mentions').filter({hasText:'Linus'}).waitFor();
    await page.locator('#desktop-chat-dock .timber-mini-agents').click();await page.locator('#panel-agents').waitFor();
    await page.locator('[data-agent-id="child-docked"]').click();await page.getByText('Review in progress.',{exact:true}).waitFor();
    await page.locator('#close-workspace').click();await page.locator('#message').waitFor();
    assert.equal(await page.locator('#message').inputValue(),'@Linus ');
    assert.match(await page.locator('.timber-selected-mentions').innerText(),/Linus/);
  });
});

test('initial conversation refresh cannot close an already opened workspace menu', async () => {
  await withPage(async ({page,state,login}) => {
    let release;state.readsGate=new Promise(resolve=>{release=resolve;});
    try {
      await login({selectFirstBot:false});await page.locator('#bot-workspace').waitFor();
      await page.locator('#panel-menu > summary').click();
      assert.equal(await page.locator('#panel-menu').evaluate(menu=>menu.open),true);
      state.readsGate=null;release();await page.locator('#stream-state').filter({hasText:'Live'}).waitFor({state:'attached'});
      assert.equal(await page.locator('#panel-menu').evaluate(menu=>menu.open),true,'a late initial snapshot preserves the user’s open menu');
      await page.locator('#tab-computer').click();await page.locator('#panel-computer').waitFor();
    } finally {release();}
  });
});

test('undelivered subagent reports remain visible after reload without changing saved success', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp=new Date().toISOString(),agentId='child-report';
    state.agents.set(BOT_A,[{id:agentId,name:'Researcher',task:'Review persistence',parentOperationId:'parent',operationId:'child',status:'completed',result:'The review is complete.',createdAt:stamp,updatedAt:stamp}]);
    state.agentMessages.set(agentId,[{id:'saved-result',role:'assistant',text:'The review is complete.',createdAt:stamp}]);
    await login();await page.locator(`[data-chat-agent="${agentId}"]`).click();await page.getByText('The review is complete.',{exact:true}).waitFor();
    const message='The subagent result is saved, but its parent could not be notified.';
    state.emit(BOT_A,'subagent.report_failed',{subagentId:agentId,errorCode:'parent_report_failed',message});
    await page.locator(`[data-agent-report-error="${agentId}"]`).filter({hasText:message}).waitFor();
    assert.equal(await page.locator('.timber-agent-detail-heading [data-status="completed"]').count(),1);
    await page.reload();await page.locator(`[data-agent-report-error="${agentId}"]`).filter({hasText:message}).waitFor();
    await page.getByText('The review is complete.',{exact:true}).waitFor();
    assert.equal(await page.locator('.timber-agent-detail-heading [data-status="completed"]').count(),1,'notification failure does not mislabel the completed subagent task');
  });
});

test('promptbox attaches, pastes and drops images; removes previews and sends image-only input', async () => {
  await withPage(async ({page,login,state}) => {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    const uploaded=[];
    await page.route('**/attachments/*',async route=>{
      uploaded.push(route.request().url());
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({attachment:{artifactId:route.request().url().split('/').pop(),mimeType:'image/png',size:png.length}})});
    });
    await login();
    await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles({name:'picked.png',mimeType:'image/png',buffer:png});
    await page.locator('.timber-image-attachments img').waitFor();
    await page.evaluate(bytes=>{
      const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(bytes)],'pasted.png',{type:'image/png'}));
      document.querySelector('#message').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    },[...png]);
    await page.evaluate(bytes=>{
      const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(bytes)],'dropped.png',{type:'image/png'}));
      document.querySelector('#message-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    },[...png]);
    assert.equal(await page.locator('.timber-image-attachments img').count(),3);
    await page.getByRole('button',{name:'Remove picked.png',exact:true}).click();
    assert.equal(await page.locator('.timber-image-attachments img').count(),2);
    await sendMessage(page);
    await page.waitForFunction(()=>document.querySelectorAll('.timber-image-attachments img').length===0);
    assert.equal(uploaded.length,2);
    const sent=sentMessages(state,BOT_A);assert.equal(sent.length,1);assert.equal(sent[0].body.text,'');assert.equal(sent[0].body.attachments.length,2);
  });
});

test('an uncertain image send retains previews and retries the same message and attachments', async () => {
  await withPage(async ({page,login,state}) => {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    let uploads=0;const deliveries=[];
    await page.route('**/attachments/*',async route=>{uploads++;await route.fulfill({status:200,contentType:'application/json',body:'{}'});});
    await page.route(`**/v1/bots/${BOT_A}/messages`,async route=>{
      if(route.request().method()!=='POST') return route.continue();
      deliveries.push(route.request().postDataJSON());
      if(deliveries.length===1) {await route.fetch();await route.abort();} else await route.continue();
    });
    await login();await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles({name:'retry.png',mimeType:'image/png',buffer:png});
    await page.locator('#message').fill('Inspect this image');await sendMessage(page);
    await page.locator('#message-form [role=alert]').waitFor();
    assert.equal(await page.locator('.timber-image-attachments img').count(),1);
    await sendMessage(page);
    await page.waitForFunction(()=>document.querySelectorAll('.timber-image-attachments img').length===0);
    assert.equal(uploads,1);assert.equal(deliveries.length,2);assert.deepEqual(deliveries[0],deliveries[1]);
    assert.equal(state.messages.get(BOT_A).filter(message=>message.text==='Inspect this image').length,1);

  });
});

test('Retry sending clears only accepted image previews after a failed delivery', async () => {
  await withPage(async ({page,login,state}) => {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    let uploads=0;const deliveries=[];
    await page.route('**/attachments/*',async route=>{uploads++;await route.fulfill({status:200,contentType:'application/json',body:'{}'});});
    await page.route(`**/v1/bots/${BOT_A}/messages`,async route=>{
      if(route.request().method()!=='POST') return route.continue();
      deliveries.push(route.request().postDataJSON());
      if(deliveries.length===1) {await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Try again'}})});} else await route.continue();
    });
    await login();await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles({name:'retry.png',mimeType:'image/png',buffer:png});
    await page.locator('#message').fill('Inspect this image');await sendMessage(page);
    await page.locator('#message-form [role=alert]').waitFor();
    assert.equal(await page.locator('.timber-image-attachments img').count(),1);
    await page.getByRole('button',{name:'Retry sending',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.timber-image-attachments img').length===0);
    assert.equal(uploads,1);assert.equal(deliveries.length,2);assert.deepEqual(deliveries[0],deliveries[1]);
    assert.equal(state.messages.get(BOT_A).filter(message=>message.text==='Inspect this image').length,1);

  });
});

for (const viewport of [{width:1440,height:1050},{width:390,height:844}]) test(`agent creation cards and centered messages survive live updates and reload at ${viewport.width}px`, async () => {
  await withPage(async ({page,state,login}) => {
    const stamp='2026-10-09T12:00:00.000Z',run={id:'collab-root',botId:BOT_A,operationId:'collab-root-operation',status:'running',createdAt:stamp,updatedAt:stamp};
    const agent={id:'collab-researcher',name:'Researcher',task:'Review architecture and persistence',parentOperationId:run.operationId,operationId:'collab-spawn-operation',status:'queued',createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run,{id:'collab-child-run',botId:BOT_A,operationId:agent.operationId,subagentId:agent.id,parentRunId:run.id,status:'running',createdAt:stamp,updatedAt:stamp}]);
    state.messages.set(BOT_A,[{id:'collab-request',botId:BOT_A,runId:run.id,role:'user',text:'Ask a researcher to review persistence, then compare notes with Linus.',createdAt:stamp},{id:'collab-progress',botId:BOT_A,runId:run.id,role:'assistant',kind:'progress',text:'I’m creating a researcher and sharing the review with Linus.',createdAt:stamp}]);
    state.agentMessages.set(agent.id,[{id:'collab-agent-result',role:'assistant',text:'Persistence and reconnect behavior are covered.',createdAt:stamp}]);
    await login();
    state.emit(BOT_A,'tool.started',{toolName:'spawn_subagent',toolCallId:'collab-spawn-call'},run.id);
    state.agents.set(BOT_A,[agent]);
    state.emit(BOT_A,'subagent.created',{subagent:agent,operationId:agent.operationId,toolCallId:'collab-spawn-call'},'collab-child-run');
    state.emit(BOT_A,'tool.completed',{toolName:'spawn_subagent',toolCallId:'collab-spawn-call',operationId:agent.operationId,result:{status:'completed'}},run.id);
    const card=page.locator(`[data-agent-created="${agent.id}"]`);
    await card.getByRole('button',{name:'Open Researcher conversation',exact:true}).waitFor();assert.equal(await card.locator('[data-status="queued"]').count(),1);
    assert.equal(await card.locator('.timber-agent-created-details').count(),0,'creation starts as a collapsed pill');
    const pillBox=await card.locator('.timber-agent-created-pill').boundingBox(),cardBox=await card.boundingBox();
    assert.ok(pillBox&&cardBox&&pillBox.height<=44&&pillBox.width<=400,'creation remains a compact pill');
    assert.ok(Math.abs(pillBox.x+pillBox.width/2-cardBox.x-cardBox.width/2)<2,'the creation pill is centered in the conversation');
    await card.getByRole('button',{name:'Show Researcher agent details',exact:true}).click();
    await card.getByText('Review architecture and persistence',{exact:true}).waitFor();
    assert.equal(await card.getByRole('button',{name:'Hide Researcher agent details',exact:true}).getAttribute('aria-expanded'),'true');
    await card.getByRole('button',{name:'Hide Researcher agent details',exact:true}).click();
    agent.status='running';agent.updatedAt='2026-10-09T12:00:01.000Z';state.emit(BOT_A,'subagent.updated',{subagent:agent},'collab-child-run');
    await card.locator('[data-status="running"]').waitFor();
    state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:'collab-send-call'},run.id);
    state.emit(BOT_A,'subagent.message.sent',{targetSubagentId:agent.id,sourceName:'Ada',targetName:agent.name,text:'Also check recovery after reconnect.',operationId:'collab-send',toolCallId:'collab-send-call'},run.id);
    state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'collab-send-call',operationId:'collab-send',result:{status:'completed'}},run.id);
    state.emit(BOT_A,'subagent.reported',{subagentId:agent.id,text:'The saved result survives reconnect.',operationId:'collab-report'},run.id);
    state.emit(BOT_A,'subagent.message.sent',{sourceSubagentId:agent.id,sourceName:agent.name,targetName:'Ada',text:'The saved result survives reconnect.',operationId:'collab-report',toolCallId:'collab-report-call'},'collab-child-run');
    await page.locator('[data-collaboration-notice="sent:collab-send"]').filter({hasText:'Messages to'}).waitFor();
    await page.locator('[data-collaboration-notice="sent:collab-report"]').filter({hasText:'Messages from'}).waitFor();
    assert.equal(await page.locator('[data-collaboration-notice]').count(),2,'explicit child report and its durable parent receipt form one notice');
    assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0,'successful agent operations use their product cards without duplicate generic tool rows');
    await page.getByRole('button',{name:'Show message to Researcher',exact:true}).click();await page.getByText('Also check recovery after reconnect.',{exact:true}).waitFor();
    if(process.env.TIMBER_CAPTURE_UI){
      await page.screenshot({path:`/tmp/timber-collaboration-${viewport.width}.png`});
      await page.screenshot({path:`/tmp/timber-pill-${viewport.width}-light.png`});
      await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:`/tmp/timber-pill-${viewport.width}-dark.png`});
      await card.getByRole('button',{name:'Show Researcher agent details',exact:true}).click();await page.screenshot({path:`/tmp/timber-pill-${viewport.width}-dark-expanded.png`});
      await card.getByRole('button',{name:'Hide Researcher agent details',exact:true}).click();await page.emulateMedia({colorScheme:'light'});
    }
    await card.getByRole('button',{name:'Open Researcher conversation',exact:true}).click();await page.locator(`[data-agent-detail="${agent.id}"]`).waitFor();await page.getByText('Persistence and reconnect behavior are covered.',{exact:true}).waitFor();
    await openPanel(page,'conversation');await page.reload();await page.locator(`[data-agent-created="${agent.id}"] [data-status="running"]`).waitFor();
    await page.locator('[data-collaboration-notice="sent:collab-report"]').waitFor();assert.equal(await page.locator('[data-collaboration-notice]').count(),2);assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0);
    await page.locator('[data-collaboration-notice="sent:collab-report"]').getByRole('button',{name:'Open Researcher conversation',exact:true}).click();await page.locator(`[data-agent-detail="${agent.id}"]`).waitFor();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  },{viewport,...(viewport.width<760?{isMobile:true,hasTouch:true}:{})});
});

test('named agent creation and incoming collaboration use direct colored conversation links', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp='2026-10-09T12:02:00.000Z',run={id:'named-collab-run',botId:BOT_A,operationId:'named-collab-op',status:'completed',createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'named-request',botId:BOT_A,runId:run.id,role:'user',text:'Create a persistent reviewer and share the review.',createdAt:stamp}]);
    state.bots.find(bot=>bot.id===BOT_B).createdByBotId=BOT_A;
    state.emit(BOT_A,'tool.started',{toolName:'create_bot',toolCallId:'create-named-call'},run.id);
    state.emit(BOT_A,'agent.named.created',{bot:{id:BOT_B,name:'Linus'},operationId:'create-named-operation',toolCallId:'create-named-call'},run.id);
    state.emit(BOT_A,'tool.completed',{toolName:'create_bot',toolCallId:'create-named-call',operationId:'create-named-operation',result:{status:'completed'}},run.id);
    const delegation={id:'named-task',sourceBotId:BOT_A,sourceBotName:'Ada',sourceRunId:run.id,targetBotId:BOT_B,targetBotName:'Linus',path:[BOT_A,BOT_B],status:'running',createdAt:stamp,updatedAt:stamp};
    state.delegations.set(BOT_A,[delegation]);
    state.emit(BOT_A,'tool.started',{toolName:'send_to_bot',toolCallId:'send-named-call'},run.id);
    state.emit(BOT_A,'delegation.updated',{delegation,operationId:'send-named-operation',toolCallId:'send-named-call'},run.id);
    state.emit(BOT_A,'tool.completed',{toolName:'send_to_bot',toolCallId:'send-named-call',operationId:'send-named-operation',result:{status:'completed'}},run.id);
    await login();await page.locator(`[data-agent-created="${BOT_B}"]`).getByRole('button',{name:'Open Linus conversation',exact:true}).waitFor();
    await page.locator('[data-collaboration-notice="delegation:named-task"]').filter({hasText:'Messages to'}).waitFor();
    const incoming={id:'named-incoming',botId:BOT_A,runId:run.id,role:'assistant',text:'The review is complete. **Persistence looks good.**',provenance:{kind:'delegation_result',sourceBotId:BOT_B,sourceBotName:'Linus',delegationId:delegation.id},createdAt:'2026-10-09T12:03:00.000Z'};
    state.messages.get(BOT_A).push(incoming);state.emit(BOT_A,'message.created',{message:incoming},run.id);
    delegation.status='completed';delegation.updatedAt=incoming.createdAt;state.emit(BOT_A,'delegation.updated',{delegation},run.id);
    await page.locator('[data-message-id="named-incoming"]').filter({hasText:'Messages from'}).waitFor();assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0);
    await page.getByRole('button',{name:'Show message from Linus',exact:true}).click();await page.getByText('Persistence looks good.',{exact:true}).waitFor();
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:'/tmp/timber-named-collaboration-1440.png'});
    const color=await page.locator(`[data-agent-created="${BOT_B}"] [data-agent-color]`).getAttribute('data-agent-color');
    assert.equal(await page.locator(`[data-bot-id="${BOT_B}"] [data-agent-color]`).getAttribute('data-agent-color'),color);
    assert.notEqual(await page.locator(`[data-bot-id="${BOT_A}"] [data-agent-color]`).getAttribute('data-agent-color'),color);
    await page.locator('[data-message-id="named-incoming"]').getByRole('button',{name:'Open Linus conversation',exact:true}).click();await until(page,'#selected-name','Linus');assert.equal(await page.locator('#selected-avatar').getAttribute('data-agent-color'),color);
    await selectBot(page,BOT_A);await page.locator('[data-message-id="named-incoming"]').waitFor();await page.locator('[data-collaboration-notice="delegation:named-task"]').waitFor();assert.equal(await page.locator('[data-collaboration-notice="delegation:named-task"]').count(),1);
  });
});

test('background exec keeps independent processes running after the response and merges late receipts on reload', async () => {
  await withPage(async ({page,state,login}) => {
    const createdAt=new Date().toISOString(),run={id:'background-response-run',botId:BOT_A,operationId:'background-response',status:'running',createdAt,updatedAt:createdAt};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'background-request',botId:BOT_A,runId:run.id,role:'user',text:'Start the two builds.',createdAt}]);
    const update=(processId,status,output,extra={})=>state.emit(BOT_A,'process.updated',{processId,operationId:processId,toolCallId:`call-${processId}`,input:{command:'npm run build',yieldMs:1000},result:{operationId:processId,processId,status,output},...extra},run.id);
    for(const processId of ['background-process-a','background-process-b']) {
      state.emit(BOT_A,'tool.started',{operationId:processId,toolCallId:`call-${processId}`,toolName:'exec',input:{command:'npm run build',yieldMs:1000}},run.id);
      update(processId,'running',`Started ${processId}\n`);
      state.emit(BOT_A,'tool.completed',{operationId:processId,toolCallId:`call-${processId}`,toolName:'exec',result:{operationId:processId,processId,status:'running',output:`Started ${processId}\n`}},run.id);
    }
    await login();
    const first=page.locator('#messages [data-tool-operation-id="background-process-a"]'),second=page.locator('#messages [data-tool-operation-id="background-process-b"]');
    await first.locator('.timber-tool-status[aria-label="Running"]').waitFor();await second.locator('.timber-tool-status[aria-label="Running"]').waitFor();
    assert.equal(await page.locator('#messages [data-process-id]').count(),2,'identical commands retain their distinct process identities');
    assert.doesNotMatch(await first.locator('summary').innerText(),/timeout/,'omitting an execution deadline does not invent a default');
    run.status='completed';run.updatedAt=new Date(Date.now()+1000).toISOString();state.emit(BOT_A,'run.updated',{run},run.id);
    await page.locator('#run-status').waitFor({state:'hidden'});
    assert.equal(await first.locator('.timber-spinner').count(),1,'a final model response does not finish the shell process');
    assert.equal(await page.locator('#cancel-run').isVisible(),true,'Stop remains available for the completed run’s live processes');
    await openPanel(page,'computer');await page.locator('#expand-workspace').click();
    await page.locator('[data-mini-activity] .timber-mini-status').filter({hasText:'Working'}).waitFor();
    assert.equal(await page.locator('[data-mini-activity] .timber-mini-step-status[aria-label="Running"]').count(),2);
    await page.locator('#close-workspace').click();
    update('background-process-a','completed','Build A finished\n',{observationOperationId:'background-poll-a',result:{operationId:'background-poll-a',processId:'background-process-a',status:'completed',output:'Build A finished\n',exitCode:0}});
    state.emit(BOT_A,'tool.completed',{operationId:'background-process-a',toolCallId:'call-background-process-a',toolName:'exec',result:{operationId:'background-process-a',processId:'background-process-a',status:'running',output:'Old running receipt'}},run.id);
    state.emit(BOT_A,'tool.completed',{operationId:'background-process-a',toolCallId:'call-background-process-a',toolName:'exec',status:'running'},run.id);
    await first.locator('.timber-tool-status[aria-label="Completed · exit 0"]').waitFor();
    assert.equal(await first.getAttribute('data-tool-status'),'completed');assert.equal(await first.locator('.timber-spinner').count(),0);
    assert.match(await first.locator('[data-tool-result-preview]').innerText(),/Build A finished/);
    assert.equal(await second.getAttribute('data-tool-status'),'running');assert.equal(await page.locator('#messages [data-process-id]').count(),2);
    await page.reload();await first.locator('.timber-tool-status[aria-label="Completed · exit 0"]').waitFor();await second.locator('.timber-tool-status[aria-label="Running"]').waitFor();
    assert.equal(await page.locator('#messages [data-process-id]').count(),2);assert.equal(await page.locator('#cancel-run').isVisible(),true);
    assert.equal(state.actions.length,0,'status display never starts or reissues an action');
  });
});

test('background exec Stop targets the owning completed run and waits for acknowledged process cancellation', async () => {
  await withPage(async ({page,state,login}) => {
    const createdAt=new Date().toISOString(),run={id:'background-stop-run',botId:BOT_A,operationId:'background-stop-request',status:'completed',createdAt,updatedAt:createdAt},processId='background-stop-process';
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'background-stop-message',botId:BOT_A,runId:run.id,role:'user',text:'Start a long command.',createdAt}]);
    const update=(status,extra={})=>state.emit(BOT_A,'process.updated',{processId,operationId:processId,input:{command:'python render.py',yieldMs:1000},result:{operationId:processId,processId,status,output:'Rendering frame 12\n'},...extra},run.id);
    update('running');await login();await page.locator('#cancel-run').waitFor();
    const tool=page.locator(`#messages [data-tool-operation-id="${processId}"]`);
    await tool.locator('.timber-tool-status[aria-label="Running"]').waitFor();
    const stopped=page.waitForResponse(response=>response.url().endsWith(`/runs/${run.id}/cancel`));await page.locator('#cancel-run').click();await stopped;
    update('running',{cancellationRequested:true});await tool.locator('.timber-tool-status[aria-label="Stopping…"]').waitFor();
    assert.equal(await tool.getAttribute('data-tool-status'),'running','the run’s cancellation alone does not confirm the process stopped');
    assert.equal(await tool.locator('.timber-spinner').count(),1);assert.equal(await page.locator('#cancel-run').isVisible(),true);
    assert.deepEqual(state.calls.filter(call=>call.path.endsWith('/cancel')).map(call=>({path:call.path,method:call.method})),[{path:`/v1/bots/${BOT_A}/runs/${run.id}/cancel`,method:'POST'}]);
    update('cancelled',{cancellationRequested:true,observationOperationId:'background-stop-observation',result:{operationId:'background-stop-observation',processId,status:'cancelled',output:'Rendering stopped\n'}});
    await tool.locator('.timber-tool-status[aria-label="Cancelled"]').waitFor();await page.locator('#cancel-run').waitFor({state:'hidden'});
    assert.equal(await tool.locator('.timber-spinner').count(),0);
    await page.reload();await tool.locator('.timber-tool-status[aria-label="Cancelled"]').waitFor();assert.equal(await page.locator('#cancel-run').isVisible(),false);
    assert.equal(state.actions.length,0);assert.equal(sentMessages(state,BOT_A).length,0);
  });
});

test('background exec process completion overrides a stale approved running receipt in history and activity', async () => {
  await withPage(async ({page,state,login}) => {
    const createdAt=new Date().toISOString(),run={id:'background-approval-run',botId:BOT_A,operationId:'background-approval-request',status:'completed',createdAt,updatedAt:createdAt},processId='background-approved-process';
    const approval={id:'background-approval',botId:BOT_A,runId:run.id,operationId:processId,status:'completed',action:{type:'exec',command:'npm run build',yieldMs:1000},result:{operationId:processId,processId,status:'running',output:'Starting approved build\n'},createdAt,expiresAt:new Date(Date.now()+60000).toISOString()};
    state.runs.set(BOT_A,[run]);state.approvals.set(BOT_A,[approval]);state.messages.set(BOT_A,[{id:'background-approval-message',botId:BOT_A,runId:run.id,role:'user',text:'Build after approval.',createdAt}]);
    state.emit(BOT_A,'process.updated',{processId,operationId:processId,input:{command:'npm run build',yieldMs:1000},result:approval.result},run.id);
    await login();const history=page.locator('[data-approval-history-id="background-approval"]');await history.locator('summary').filter({hasText:'Running action'}).waitFor();
    state.emit(BOT_A,'process.updated',{processId,operationId:processId,observationOperationId:'background-approved-poll',input:{command:'npm run build',yieldMs:1000},result:{operationId:'background-approved-poll',processId,status:'completed',output:'Approved build finished\n',exitCode:0}},run.id);
    await history.locator('summary').filter({hasText:'Completed action'}).waitFor();await history.locator('summary').click();
    await history.locator('.timber-result-output').filter({hasText:'Approved build finished'}).waitFor();
    assert.equal(await history.locator('[data-process-status="completed"]').count(),1);assert.equal(await history.locator('.timber-spinner').count(),0);
    assert.equal(approval.result.status,'running','the persisted permission receipt deliberately remains an old snapshot');
    await openPanel(page,'activity');const activity=page.locator(`[data-activity-tool-operation-id="${processId}"]`);await activity.locator('.timber-tool-status[aria-label="Completed · exit 0"]').waitFor();
    assert.equal(await activity.getAttribute('data-tool-status'),'completed');assert.equal(await activity.locator('.timber-spinner').count(),0);
    await openPanel(page,'conversation');await page.reload();await history.locator('summary').filter({hasText:'Completed action'}).waitFor();
    await history.locator('summary').click();await history.locator('.timber-result-output').filter({hasText:'Approved build finished'}).waitFor();
    assert.equal(await page.locator('#cancel-run').isVisible(),false);
  });
});

test('sidebar summaries show latest activity and stable bot colors with bounded background requests', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp='2026-10-09T12:05:00.000Z';
    state.messages.set(BOT_B,[{id:'sidebar-b-message',botId:BOT_B,role:'assistant',text:'Reviewing the computer lifecycle.',createdAt:stamp}]);
    state.runs.set(BOT_B,[{id:'sidebar-b-run',botId:BOT_B,operationId:'sidebar-b-operation',status:'queued',createdAt:stamp,updatedAt:stamp}]);
    for(let i=3;i<=7;i++){
      const bot={...state.bots[1],id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,name:`Helper ${i}`};state.bots.push(bot);
      state.messages.set(bot.id,[{id:`helper-${i}-message`,botId:bot.id,role:'assistant',text:`Saved progress for helper ${i}.`,createdAt:stamp}]);state.runs.set(bot.id,[]);
    }
    let concurrent=0,maxConcurrent=0;
    await page.route('**/summary',async route=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);try{const response=await route.fetch();await route.fulfill({response});}finally{concurrent--;}});
    await login();const other=page.locator(`[data-bot-id="${BOT_B}"]`);
    await other.locator('.bot-preview').filter({hasText:'Reviewing the computer lifecycle.'}).waitFor();await other.locator('[data-status="queued"]').waitFor();
    await page.locator('.bot-preview').filter({hasText:'Saved progress for helper 7.'}).waitFor();
    assert.ok(maxConcurrent<=3,`summary concurrency was ${maxConcurrent}`);
    assert.equal(state.calls.filter(call=>/\/messages(?:\?|$)|\/runs(?:\?|$)/.test(call.path)&&!call.path.startsWith(`/v1/bots/${BOT_A}/`)).length,0,'background bots fetch compact summaries, never their whole transcripts or runs');
    const color=await other.locator('[data-agent-color]').getAttribute('data-agent-color');
    state.runs.get(BOT_B)[0].status='running';state.messages.get(BOT_B).push({id:'sidebar-b-new',botId:BOT_B,role:'assistant',text:'The lifecycle fix is ready for review.',createdAt:stamp});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await other.locator('[data-status="running"]').waitFor();await other.locator('.bot-preview').filter({hasText:'The lifecycle fix is ready for review.'}).waitFor();
    state.emit(BOT_A,'run.updated',{run:{id:'sidebar-live-run',botId:BOT_A,operationId:'sidebar-live-operation',status:'queued',createdAt:stamp,updatedAt:stamp}},'sidebar-live-run');
    await page.locator(`[data-bot-id="${BOT_A}"] [data-status="queued"]`).waitFor();
    const message={id:'sidebar-live-message',botId:BOT_A,runId:'sidebar-live-run',role:'assistant',text:'Coordinating the next task.',createdAt:stamp};state.messages.get(BOT_A).push(message);state.emit(BOT_A,'message.created',{message},'sidebar-live-run');
    await page.locator(`[data-bot-id="${BOT_A}"] .bot-preview`).filter({hasText:'Coordinating the next task.'}).waitFor();
    await page.locator('#message').fill('@Lin');await page.locator(`[data-mention-bot="${BOT_B}"]`).waitFor();assert.equal(await page.locator(`[data-mention-bot="${BOT_B}"] [data-agent-color]`).getAttribute('data-agent-color'),color);
    await page.reload();await other.locator('.bot-preview').filter({hasText:'The lifecycle fix is ready for review.'}).waitFor();assert.equal(await other.locator('[data-agent-color]').getAttribute('data-agent-color'),color);
    if(process.env.TIMBER_CAPTURE_UI){await page.screenshot({path:'/tmp/timber-sidebar-1440.png'});await page.setViewportSize({width:390,height:844});await page.locator('#mobile-back').click();await page.screenshot({path:'/tmp/timber-sidebar-390.png'});}
  });
});

test('child collaboration keeps creation cards and messages scoped to its conversation after reload', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp='2026-10-09T13:00:00.000Z',parentRun={id:'child-scope-root',botId:BOT_A,operationId:'child-scope-root-op',status:'completed',createdAt:stamp,updatedAt:stamp};
    const researcher={id:'child-scope-researcher',name:'Researcher',task:'Coordinate a scoped review.',parentOperationId:parentRun.operationId,operationId:'child-scope-research-op',status:'running',createdAt:stamp,updatedAt:stamp};
    const sibling={...researcher,id:'child-scope-sibling',name:'Sibling',operationId:'child-scope-sibling-op'};
    const nested={...researcher,id:'child-scope-nested',name:'Verifier',parentSubagentId:researcher.id,operationId:'child-scope-spawn',task:'Verify the findings.'};
    const childRun={...parentRun,id:'child-scope-run',subagentId:researcher.id,parentRunId:parentRun.id,operationId:researcher.operationId,status:'running'};
    const siblingRun={...childRun,id:'child-scope-sibling-run',subagentId:sibling.id,operationId:sibling.operationId};
    state.runs.set(BOT_A,[parentRun,childRun,siblingRun,{...childRun,id:'child-scope-nested-run',subagentId:nested.id,operationId:nested.operationId}]);
    state.agents.set(BOT_A,[researcher,sibling,nested]);state.bots.find(bot=>bot.id===BOT_B).createdByBotId=BOT_A;
    state.agentMessages.set(researcher.id,[{id:'child-scope-task',role:'user',text:'Coordinate a scoped review.',createdAt:stamp},{id:'child-scope-plain-message',role:'user',text:'Message from Sibling:\nThe source transcript remains available.',createdAt:stamp}]);
    state.agentMessages.set(nested.id,[{id:'child-scope-verifier-result',role:'assistant',text:'The scoped findings are verified.',createdAt:stamp}]);
    const childTool=(operationId,toolName,toolCallId)=>{
      state.emit(BOT_A,'subagent.tool.started',{subagentId:researcher.id,toolCallId,toolName},childRun.id);
      state.emit(BOT_A,'subagent.tool.completed',{subagentId:researcher.id,operationId,toolCallId,toolName,status:'completed'},childRun.id);
    };
    childTool(nested.operationId,'spawn_subagent','child-scope-spawn-call');
    state.emit(BOT_A,'subagent.created',{subagent:nested,operationId:nested.operationId,toolCallId:'child-scope-spawn-call'},'child-scope-nested-run');
    childTool('child-scope-create-bot','create_bot','child-scope-create-call');
    state.emit(BOT_A,'agent.named.created',{bot:{id:BOT_B,name:'Linus'},operationId:'child-scope-create-bot',toolCallId:'child-scope-create-call'},childRun.id);
    await login();await openPanel(page,'agents');await page.locator(`[data-agent-id="${researcher.id}"]`).click();
    const detail=page.locator(`[data-agent-detail="${researcher.id}"]`);
    await detail.locator(`[data-agent-created="${nested.id}"]`).waitFor();await detail.locator(`[data-agent-created="${BOT_B}"]`).waitFor();
    assert.equal(await detail.locator(`[data-agent-created="${researcher.id}"], [data-agent-created="${sibling.id}"]`).count(),0,'the child only lists agents it created');
    childTool('child-scope-send-root','send_subagent_message','child-scope-send-root-call');
    state.emit(BOT_A,'subagent.message.sent',{sourceSubagentId:researcher.id,sourceName:researcher.name,targetName:'Ada',operationId:'child-scope-send-root',toolCallId:'child-scope-send-root-call',text:'The parent can use these findings.'},childRun.id);
    state.emit(BOT_A,'subagent.reported',{subagentId:researcher.id,operationId:'child-scope-send-root',text:'The parent can use these findings.'},parentRun.id);
    state.emit(BOT_A,'subagent.message.sent',{sourceSubagentId:sibling.id,targetSubagentId:researcher.id,sourceName:sibling.name,targetName:researcher.name,operationId:'child-scope-incoming',text:'The source transcript remains available.'},siblingRun.id);
    state.emit(BOT_A,'subagent.message.sent',{targetSubagentId:sibling.id,targetName:sibling.name,operationId:'child-scope-unrelated',text:'This belongs to a different child.'},parentRun.id);
    await detail.locator('[data-collaboration-notice="sent:child-scope-send-root"]').filter({hasText:'Messages to'}).waitFor();
    await detail.locator('[data-collaboration-notice="sent:child-scope-incoming"]').filter({hasText:'Messages from'}).waitFor();
    assert.equal(await detail.locator('[data-collaboration-notice]').count(),2,'the explicit report and receipt are one outgoing notice');
    assert.equal(await detail.locator('[data-collaboration-notice="sent:child-scope-unrelated"]').count(),0);
    assert.equal(await detail.locator('.timber-agent-activity').count(),0,'successful child collaboration has no duplicate generic tool section');
    await detail.locator('[data-agent-message="child-scope-plain-message"]').filter({hasText:'The source transcript remains available.'}).waitFor();
    await detail.getByRole('button',{name:'Show message to Ada',exact:true}).click();await detail.getByText('The parent can use these findings.',{exact:true}).waitFor();
    await page.reload();await detail.locator(`[data-agent-created="${nested.id}"]`).waitFor();await detail.locator('[data-collaboration-notice="sent:child-scope-incoming"]').waitFor();
    assert.equal(await detail.locator('[data-collaboration-notice]').count(),2);assert.equal(await detail.locator('.timber-agent-activity').count(),0);
    await detail.locator(`[data-agent-created="${nested.id}"]`).getByRole('button',{name:'Open Verifier conversation',exact:true}).click();await page.locator(`[data-agent-detail="${nested.id}"]`).getByText('The scoped findings are verified.',{exact:true}).waitFor();
  });
});

test('sidebar image-only messages replace an older text preview and keep captions when present', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp=new Date().toISOString(),old={id:'sidebar-image-old',botId:BOT_A,role:'assistant',text:'The older text should be replaced.',createdAt:stamp};
    state.messages.set(BOT_A,[old]);
    await page.route(`**/v1/bots/${BOT_A}/summary`,route=>route.fulfill({json:{summary:{status:'ready',activeRuns:0,activeAgents:0,lastMessage:{text:old.text,createdAt:stamp}}}}));
    await login();const preview=page.locator(`[data-bot-id="${BOT_A}"] .bot-preview`);await preview.filter({hasText:old.text}).waitFor();
    const image={artifactId:'sidebar-preview-image',mimeType:'image/png',size:100};
    const one={id:'sidebar-image-single',botId:BOT_A,role:'user',text:'',attachments:[image],createdAt:new Date(Date.now()+1000).toISOString()};
    state.messages.get(BOT_A).push(one);state.emit(BOT_A,'message.created',{message:one});
    await preview.filter({hasText:/^Image$/}).waitFor();assert.equal(await preview.innerText(),'Image');
    const multiple={...one,id:'sidebar-image-multiple',text:'   ',attachments:[image,{...image,artifactId:'sidebar-preview-image-two'}],createdAt:new Date(Date.now()+2000).toISOString()};
    state.messages.get(BOT_A).push(multiple);state.emit(BOT_A,'message.created',{message:multiple});
    await preview.filter({hasText:/^2 images$/}).waitFor();assert.equal(await preview.innerText(),'2 images');
    await page.reload();await preview.filter({hasText:/^2 images$/}).waitFor();
    const captioned={...multiple,id:'sidebar-image-captioned',text:'Compare these diagrams.',createdAt:new Date(Date.now()+3000).toISOString()};
    state.messages.get(BOT_A).push(captioned);state.emit(BOT_A,'message.created',{message:captioned});
    await preview.filter({hasText:/^Compare these diagrams\.$/}).waitFor();assert.equal(await preview.innerText(),captioned.text);
  });
});

test('selected sidebar keeps readable contrast when switching between light and dark themes', async () => {
  await withPage(async ({page,login}) => {
    await login();
    for(const colorScheme of ['light','dark']){
      await page.emulateMedia({colorScheme});
      const colors=await page.locator('.bot-item.selected').evaluate(button=>{
        const rgb=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
        const background=rgb(getComputedStyle(button).backgroundColor),name=rgb(getComputedStyle(button.querySelector('.bot-name')).color),preview=rgb(getComputedStyle(button.querySelector('.bot-preview')).color);
        const luminance=channels=>channels.map(channel=>{const n=channel/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((total,n,index)=>total+n*[.2126,.7152,.0722][index],0);
        const contrast=color=>{const a=luminance(color),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
        return {background,nameContrast:contrast(name),previewContrast:contrast(preview)};
      });
      assert.ok(colors.nameContrast>=4.5,`${colorScheme} selected bot name has ${colors.nameContrast.toFixed(2)}:1 contrast`);
      if(colorScheme==='dark')assert.ok(colors.previewContrast>=4.5,`dark selected preview has ${colors.previewContrast.toFixed(2)}:1 contrast`);
      if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-sidebar-contrast-${colorScheme}.png`});
    }
  });
});

for(const approved of [false,true]) test(`checkpoint recovery replaces stale warnings while preserving successful ${approved?'approved':'automatic'} commands`, async () => {
  await withPage(async ({page,state,login}) => {
    const createdAt=new Date().toISOString(),processId=`checkpoint-process-${approved?'approved':'automatic'}`,run={id:`checkpoint-run-${approved}`,botId:BOT_A,operationId:`checkpoint-request-${approved}`,status:'completed',createdAt,updatedAt:createdAt};
    const oldResult={operationId:processId,processId,status:'completed',checkpointStatus:'pending',output:'Wrote report.txt\n',exitCode:0,error:'Workspace checkpoint is temporarily unavailable.'};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:`checkpoint-message-${approved}`,botId:BOT_A,runId:run.id,role:'user',text:'Create the report and save its files.',createdAt}]);
    if(approved)state.approvals.set(BOT_A,[{id:'checkpoint-approval',botId:BOT_A,runId:run.id,operationId:processId,status:'completed',action:{type:'exec',command:'python report.py',yieldMs:1000},result:oldResult,createdAt,expiresAt:new Date(Date.now()+60000).toISOString()}]);
    const update=result=>state.emit(BOT_A,'process.updated',{processId,operationId:processId,input:{command:'python report.py',yieldMs:1000},result},run.id);
    state.emit(BOT_A,'tool.completed',{operationId:processId,toolName:'exec',input:{command:'python report.py'},result:oldResult},run.id);update(oldResult);
    await login();
    const row=approved?page.locator('[data-timeline-approval="checkpoint-approval"]'):page.locator(`#messages [data-tool-operation-id="${processId}"]`);
    if(approved)await row.locator('.timber-approval-history > summary').click();
    await row.locator('.timber-save-warning').filter({hasText:oldResult.error}).waitFor();
    await row.locator('[data-checkpoint-status="pending"]').filter({hasText:'Saving files…'}).waitFor();
    assert.equal(await row.locator('.timber-inline-error').count(),0,'a checkpoint warning does not turn a successful command into a failed command');
    const pending={operationId:'checkpoint-observation',processId,status:'completed',checkpointStatus:'pending',output:oldResult.output,exitCode:0};
    update(pending);await row.locator('.timber-save-warning').waitFor({state:'hidden'});
    await row.locator('[data-checkpoint-status="pending"]').waitFor();
    const saved={...pending,checkpointStatus:'saved',checkpointId:'saved-checkpoint'};update(saved);
    state.emit(BOT_A,'tool.completed',{operationId:processId,toolName:'exec',result:oldResult},run.id);
    await row.locator('[data-checkpoint-status="pending"]').waitFor({state:'hidden'});
    assert.equal(await row.locator('.timber-save-warning,.timber-inline-error').count(),0,'a later snapshot clears fields omitted from its authoritative result');
    assert.match(await row.innerText(),/Wrote report\.txt/);
    await openPanel(page,'activity');const activity=page.locator(`[data-activity-tool-operation-id="${processId}"]`);await activity.locator('.timber-tool-status[aria-label="Completed · exit 0"]').waitFor();
    assert.equal(await activity.locator('.timber-save-warning,[data-checkpoint-status="pending"]').count(),0,'activity does not restore the persisted old receipt');
    await openPanel(page,'conversation');await page.reload();await row.waitFor();
    if(approved)await row.locator('.timber-approval-history > summary').click();
    assert.equal(await row.locator('.timber-save-warning,[data-checkpoint-status="pending"]').count(),0,'durable event replay retains the recovered checkpoint state');
    assert.match(await row.innerText(),/Wrote report\.txt/);assert.equal(await page.locator('#cancel-run').isVisible(),false,'saving files does not imply a shell process is still running');
  });
});

test('subagent reports separate attribution from new and historical bodies without changing quoted text', async () => {
  await withPage(async ({page,state,login}) => {
    const stamp='2026-10-09T15:00:00.000Z',name='Desktop visual QA & accessibility',agentId='report-body-agent';
    const run={id:'report-body-run',botId:BOT_A,operationId:'report-body-request',status:'completed',createdAt:stamp,updatedAt:stamp};
    const agent={id:agentId,name,task:'Review desktop layout and accessibility.',parentOperationId:run.operationId,operationId:'report-body-child-operation',status:'running',createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run]);state.agents.set(BOT_A,[agent]);state.messages.set(BOT_A,[{id:'report-body-request-message',botId:BOT_A,runId:run.id,role:'user',text:'Ask the desktop reviewer for a progress update.',createdAt:stamp}]);
    const host=`Subagent ${name}: `,manual=`Message from subagent ${name}:\n`,completion=`Subagent ${name} completed its task:\n`;
    const report=(operationId,text,extra={})=>state.emit(BOT_A,'subagent.reported',{subagentId:agentId,operationId,text,...extra},run.id);
    const oldEvent=report('legacy-explicit',host+manual+'Still awaiting the updated desktop build.');
    const expand=async operationId=>{const notice=page.locator(`[data-collaboration-notice="reported:${operationId}"]`);await notice.getByRole('button',{name:`Show message from ${name}`,exact:true}).click();return notice.locator('.timber-collaboration-message-body');};
    await login();const first=await expand('legacy-explicit');assert.equal(await first.innerText(),'Still awaiting the updated desktop build.');
    if(process.env.TIMBER_CAPTURE_UI){await page.screenshot({path:'/tmp/timber-report-body-1440.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/timber-report-body-390.png'});await page.setViewportSize({width:1440,height:1050});}
    const examples=[
      {id:'legacy-completion',stored:host+completion+'The desktop review is complete.',expected:'The desktop review is complete.'},
      {id:'legacy-host-only',stored:host+'The buttons are keyboard accessible.',expected:'The buttons are keyboard accessible.'},
      {id:'legacy-one-runtime-prefix',stored:host+manual+manual+'This prefix belongs to the content.',expected:manual+'This prefix belongs to the content.'},
      {id:'legacy-without-host-prefix',stored:manual+'This text has no host wrapper.',expected:manual+'This text has no host wrapper.'},
      {id:'legacy-quoted',stored:host+`Quoted example: "Message from subagent ${name}: Still awaiting…"`,expected:`Quoted example: "Message from subagent ${name}: Still awaiting…"`},
      {id:'legacy-different-name',stored:'Subagent Someone else: Message from subagent Someone else:\nPreserve this literal text.',expected:'Subagent Someone else: Message from subagent Someone else:\nPreserve this literal text.'},
      {id:'new-plain',stored:'The updated layout is ready.',expected:'The updated layout is ready.',extra:{contentFormat:'plain',subagentName:name,kind:'message'}},
      {id:'new-intentional-prefix',stored:host+manual+'Keep this intentional example unchanged.',expected:host+manual+'Keep this intentional example unchanged.',extra:{contentFormat:'plain',subagentName:name,kind:'result'}},
    ];
    for(const example of examples){report(example.id,example.stored,example.extra);assert.equal(await (await expand(example.id)).innerText(),example.expected);}
    const quotedText=host+manual+'This is ordinary assistant text quoting a transport example.';
    const quoted={id:'report-body-ordinary-message',botId:BOT_A,runId:run.id,role:'assistant',text:quotedText,createdAt:stamp};
    state.messages.get(BOT_A).push(quoted);state.emit(BOT_A,'message.created',{message:quoted},run.id);
    await page.locator(`[data-message-id="${quoted.id}"] .timber-markdown`).filter({hasText:'ordinary assistant text'}).waitFor();
    assert.equal(await page.locator(`[data-message-id="${quoted.id}"] .timber-markdown`).innerText(),quotedText);
    assert.equal(oldEvent.data.text,host+manual+'Still awaiting the updated desktop build.','historical stored events are not rewritten');
    await page.reload();assert.equal(await (await expand('legacy-explicit')).innerText(),'Still awaiting the updated desktop build.');
    assert.equal(await (await expand('new-intentional-prefix')).innerText(),examples.at(-1).expected);
    assert.equal(await page.locator(`[data-message-id="${quoted.id}"] .timber-markdown`).innerText(),quotedText);
  });
});

for(const viewport of [{width:1440,height:1050},{width:390,height:844}])test(`historical and current subagent messages use centered pills without duplicate activity at ${viewport.width}px`,async()=>{
  await withPage(async({page,state,login})=>{
    const stamp='2026-10-09T16:00:00.000Z',run={id:'pill-message-root',botId:BOT_A,operationId:'pill-message-root-op',status:'running',createdAt:stamp,updatedAt:stamp};
    const agent={id:'pill-message-child',name:'Reviewer',task:'Review the desktop changes.',parentOperationId:run.operationId,operationId:'pill-message-child-op',status:'running',createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run]);state.agents.set(BOT_A,[agent]);state.agentMessages.set(agent.id,[{id:'pill-message-reply',role:'assistant',text:'Reviewing the desktop.',createdAt:stamp}]);
    state.messages.set(BOT_A,[{id:'pill-message-request',botId:BOT_A,runId:run.id,role:'user',text:'Coordinate the review with the subagent.',createdAt:stamp}]);
    for(const operationId of ['old-unknown-one','old-unknown-two']){
      state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:`call-${operationId}`},run.id);
      state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:`call-${operationId}`,operationId,status:'completed'},run.id);
    }
    state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:'old-known-call',input:{targetId:agent.id,text:'Please review the compact message pills.'}},run.id);
    state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'old-known-call',operationId:'old-known-operation',status:'completed'},run.id);
    state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:'pending-message-call'},run.id);
    await login();
    const unknown=page.locator('[data-collaboration-notice="legacy-send:old-unknown-one"]');await unknown.filter({hasText:'Message subagent'}).waitFor();
    assert.equal(await unknown.locator('button').count(),0,'old receipts without routing or body do not invent links or empty disclosures');
    assert.equal(await unknown.locator('[data-status="completed"]').count(),1);
    const lateCancellation=state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'call-old-unknown-one',operationId:'old-unknown-one',status:'cancelled',result:{status:'cancelled',error:'Aborted after delivery.'}},run.id);
    await page.locator('#activity-list .event-title').filter({hasText:`#${lateCancellation.id} ·`}).waitFor({state:'attached'});
    assert.equal(await unknown.locator('[data-status="completed"]').count(),1,'a late cancellation cannot undo an already completed message operation');
    assert.equal(await unknown.locator('button').count(),0,'a late cancellation error does not replace its completed receipt');
    const known=page.locator('[data-collaboration-notice="legacy-send:old-known-operation"]');await known.getByRole('button',{name:'Open Reviewer conversation',exact:true}).waitFor();
    const pending=page.locator('[data-collaboration-notice]').filter({has:page.locator('[data-status="running"]')});assert.equal(await pending.count(),1,'a started send remains visibly pending');
    assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0,'message operations are represented by pills, not wide tool rows');
    for(const pill of await page.locator('#messages .timber-collaboration-message-row').all()){
      const box=await pill.boundingBox(),parent=await pill.locator('..').boundingBox();assert.ok(box&&parent&&box.height<=44);assert.ok(Math.abs(box.x+box.width/2-parent.x-parent.width/2)<2);
    }
    await known.getByRole('button',{name:'Show message to Reviewer',exact:true}).click();await known.getByText('Please review the compact message pills.',{exact:true}).waitFor();
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-message-pills-${viewport.width}.png`});
    state.emit(BOT_A,'subagent.message.sent',{targetSubagentId:agent.id,sourceName:'Ada',targetName:agent.name,text:'Please review the compact message pills.',operationId:'old-known-operation',toolCallId:'old-known-call'},run.id);
    await page.locator('[data-collaboration-notice="sent:old-known-operation"]').waitFor();await known.waitFor({state:'hidden'});
    assert.equal(await page.locator('#messages [data-collaboration-notice]').count(),4,'an authoritative receipt replaces its historical projection');
    state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'pending-message-call',operationId:'failed-message-operation',result:{status:'failed',error:'The subagent is no longer accepting messages.'}},run.id);
    const failed=page.locator('[data-collaboration-notice="legacy-send:failed-message-operation"]');await failed.locator('[data-status="failed"]').waitFor();await failed.getByRole('button',{name:'Show message to Subagent',exact:true}).click();await failed.getByText('The subagent is no longer accepting messages.',{exact:true}).waitFor();
    await openPanel(page,'activity');await page.locator('[data-activity-collaboration-notice="sent:old-known-operation"]').waitFor();assert.equal(await page.locator('#activity-tools [data-activity-tool-operation-id]').count(),0);
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-message-pills-activity-${viewport.width}.png`});
    await page.locator('[data-activity-collaboration-notice="sent:old-known-operation"]').getByRole('button',{name:'Open Reviewer conversation',exact:true}).click();await page.locator(`[data-agent-detail="${agent.id}"]`).waitFor();
    await openPanel(page,'conversation');await page.reload();await page.locator('[data-collaboration-notice="sent:old-known-operation"]').waitFor();assert.equal(await page.locator('#messages [data-collaboration-notice]').count(),4);assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0);
  },{viewport,...(viewport.width<760?{isMobile:true,hasTouch:true}:{})});
});

test('nested historical messages resolve parent routing and reused call IDs remain scoped to their runs',async()=>{
  await withPage(async({page,state,login})=>{
    const stamp='2026-10-09T17:00:00.000Z',root={id:'message-scope-root',botId:BOT_A,operationId:'message-scope-root-op',status:'running',createdAt:stamp,updatedAt:stamp};
    const agent={id:'message-scope-child',name:'Researcher',task:'Coordinate a review.',parentOperationId:root.operationId,operationId:'message-scope-child-op',status:'running',createdAt:stamp,updatedAt:stamp};
    const nested={...agent,id:'message-scope-nested',name:'Verifier',parentSubagentId:agent.id,operationId:'message-scope-nested-op'};
    const childRun={...root,id:'message-scope-child-run',operationId:agent.operationId,subagentId:agent.id,parentRunId:root.id},nestedRun={...childRun,id:'message-scope-nested-run',operationId:nested.operationId,subagentId:nested.id,parentRunId:childRun.id},otherRun={...root,id:'message-scope-other',operationId:'message-scope-other-op'};
    state.runs.set(BOT_A,[root,childRun,nestedRun,otherRun]);state.agents.set(BOT_A,[agent,nested]);state.messages.set(BOT_A,[]);
    state.emit(BOT_A,'subagent.tool.started',{subagentId:nested.id,toolName:'send_subagent_message',toolCallId:'nested-message-call',arguments:{targetId:'parent',text:'The findings are verified.'}},nestedRun.id);
    state.emit(BOT_A,'subagent.tool.completed',{subagentId:nested.id,toolName:'send_subagent_message',toolCallId:'nested-message-call',operationId:'nested-message-operation',status:'completed'},nestedRun.id);
    state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:'reused-call',input:{targetId:agent.id,text:'First task message.'}},root.id);
    state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'reused-call',operationId:'first-task-message',status:'completed'},root.id);
    state.emit(BOT_A,'subagent.message.sent',{targetSubagentId:agent.id,sourceName:'Ada',targetName:agent.name,text:'First task message.',operationId:'first-task-message',toolCallId:'reused-call'},root.id);
    state.emit(BOT_A,'tool.started',{toolName:'send_subagent_message',toolCallId:'reused-call',input:{targetId:agent.id,text:'Second task message.'}},otherRun.id);
    state.emit(BOT_A,'tool.completed',{toolName:'send_subagent_message',toolCallId:'reused-call',operationId:'second-task-message',status:'completed'},otherRun.id);
    await login();await page.locator('[data-collaboration-notice="sent:first-task-message"]').waitFor();await page.locator('[data-collaboration-notice="legacy-send:second-task-message"]').waitFor();
    const notice=page.locator('[data-collaboration-notice="legacy-send:nested-message-operation"]');await notice.getByRole('button',{name:'Open Researcher conversation',exact:true}).waitFor();await notice.getByRole('button',{name:'Open Verifier conversation',exact:true}).click();
    const detail=page.locator(`[data-agent-detail="${nested.id}"]`);await detail.locator('[data-collaboration-notice="legacy-send:nested-message-operation"]').filter({hasText:'Messages to'}).waitFor();assert.equal(await detail.locator('.timber-agent-activity').count(),0);
    await detail.getByRole('button',{name:'Show message to Researcher',exact:true}).click();await detail.getByText('The findings are verified.',{exact:true}).waitFor();
    await openPanel(page,'runs');await page.locator(`[data-run-id="${otherRun.id}"]`).getByRole('button',{name:'View messages',exact:true}).click();
    await page.locator('#messages [data-collaboration-notice="legacy-send:second-task-message"]').waitFor();assert.equal(await page.locator('#messages [data-collaboration-notice="sent:first-task-message"]').count(),0);
    await page.reload();await page.locator('[data-collaboration-notice="legacy-send:second-task-message"]').waitFor();assert.equal(await page.locator('#messages [data-tool-operation-id]').count(),0);
  });
});

test('subagent activity preserves completed effects and clears recovered checkpoint warnings after Stop',async()=>{
  await withPage(async({page,state,login})=>{
    const createdAt=new Date().toISOString(),root={id:'child-stop-root',botId:BOT_A,operationId:'child-stop-root-op',status:'cancelled',createdAt,updatedAt:createdAt};
    const agent={id:'child-stop-agent',name:'Reviewer',task:'Review saved files.',parentOperationId:root.operationId,operationId:'child-stop-op',status:'cancelled',createdAt,updatedAt:createdAt};
    const run={...root,id:'child-stop-run',operationId:agent.operationId,subagentId:agent.id,parentRunId:root.id};
    state.runs.set(BOT_A,[root,run]);state.agents.set(BOT_A,[agent]);
    const emit=(operationId,result,toolName='exec')=>state.emit(BOT_A,'subagent.tool.completed',{subagentId:agent.id,toolCallId:`call-${operationId}`,operationId,toolName,...(result?{result}:{})},run.id);
    emit('native-finished',undefined,'read');
    // Native toolCompletion emits only correlation fields and a flat status.
    state.emit(BOT_A,'subagent.tool.completed',{subagentId:agent.id,toolCallId:'call-native-finished',operationId:'native-finished',toolName:'read',status:'cancelled'},run.id);
    emit('saved-effect',{status:'completed',processId:'saved-effect',output:'Saved the report.',checkpointStatus:'pending',error:'Temporary save warning.'});
    emit('saved-effect',{status:'cancelled',error:'Late abort'});
    emit('stopped-effect',{status:'cancelled',output:'Partial work retained.',error:'The action was cancelled.'});
    await login();await openPanel(page,'agents');await page.locator(`[data-agent-id="${agent.id}"]`).click();
    const activity=page.locator('.timber-agent-activity');await activity.locator('summary').click();
    assert.equal(await activity.locator('[data-status="completed"]').count(),2);
    assert.equal(await activity.locator('[data-status="cancelled"]').count(),1);
    assert.equal(await activity.locator('.error').count(),0,'cancelled actions use neutral status and do not show a repeated error');
    await activity.locator('.timber-save-warning').filter({hasText:'Temporary save warning.'}).waitFor();
    state.emit(BOT_A,'subagent.process.updated',{subagentId:agent.id,processId:'saved-effect',operationId:'saved-effect',result:{status:'completed',processId:'saved-effect',output:'Saved the report.',checkpointStatus:'saved'}},run.id);
    await activity.locator('.timber-save-warning').waitFor({state:'hidden'});
    assert.equal(await activity.locator('[data-status="completed"]').count(),2);
    await page.reload();await page.locator(`[data-agent-detail="${agent.id}"]`).waitFor();await activity.locator('summary').click();
    assert.equal(await activity.locator('[data-status="completed"]').count(),2);assert.equal(await activity.locator('.error,.timber-save-warning').count(),0);
  });
});

for(const viewport of [{width:1440,height:1050},{width:390,height:844}])test(`promptbox model settings use account capabilities and preserve drafts at ${viewport.width}px`,async()=>{
  await withPage(async({page,state,login})=>{
    state.modelCatalog.models.push({id:'account-reviewer',name:'Account reviewer',provider:'openai',reasoningEfforts:['high','xhigh'],defaultReasoningEffort:'high',supportsFast:true},{id:'account-basic',name:'Account basic',provider:'openai',reasoningEfforts:[],supportsFast:false});
    await page.route('**/attachments/*',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
    await login();await page.locator('#message').fill('Keep this draft and its image.');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles({name:'model-review.png',mimeType:'image/png',buffer:png});
    const color=await page.locator('#selected-avatar').getAttribute('data-agent-color');
    const trigger=page.getByRole('button',{name:/^Model settings:/});await trigger.click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true}),model=settings.getByRole('combobox',{name:'Model',exact:true});
    await model.selectOption('account-reviewer');await trigger.filter({hasText:'Account reviewer'}).waitFor();
    assert.equal(await settings.getByRole('combobox',{name:'Reasoning effort'}).inputValue(),'high','a new model uses its declared default rather than a hardcoded low setting');
    await settings.getByRole('switch',{name:'Fast mode'}).click();await trigger.locator('[aria-label="Fast mode"]').waitFor();assert.equal(await settings.getByRole('switch',{name:'Fast mode'}).isChecked(),true,'Fast is displayed after the server acknowledges the setting');
    await settings.getByRole('combobox',{name:'Reasoning effort'}).selectOption('xhigh');await trigger.filter({hasText:'Extra high'}).waitFor();
    assert.deepEqual(state.calls.filter(call=>call.method==='PATCH').map(call=>Object.keys(call.body).sort()),Array.from({length:3},()=>['fast','model','reasoningEffort']),'model changes never resend unrelated bot fields');
    assert.equal(await page.locator('#selected-avatar').getAttribute('data-agent-color'),color,'model identity does not replace the stable bot color');
    assert.equal(await page.locator('#selected-avatar .timber-model-badge').getAttribute('data-model'),'account-reviewer');
    assert.equal(await page.locator('#message').inputValue(),'Keep this draft and its image.');assert.equal(await page.locator('.timber-image-attachments img').count(),1);
    if(process.env.TIMBER_CAPTURE_UI){await page.screenshot({path:`/tmp/timber-model-settings-${viewport.width}.png`,animations:'disabled'});await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:`/tmp/timber-model-settings-${viewport.width}-dark.png`,animations:'disabled'});await page.emulateMedia({colorScheme:'light'});await settings.getByRole('button',{name:'Close model settings'}).click();await page.screenshot({path:`/tmp/timber-model-controls-${viewport.width}.png`,animations:'disabled'});await trigger.click();}
    state.patchError={code:'settings_unavailable',message:'Model settings could not be saved.'};
    await model.selectOption('account-basic');await settings.getByRole('alert').filter({hasText:'Model settings could not be saved.'}).waitFor();
    assert.equal(await model.inputValue(),'account-reviewer');assert.equal(await page.locator('.timber-image-attachments img').count(),1);assert.equal(await page.locator('#message').inputValue(),'Keep this draft and its image.');
    state.patchError=null;let release;state.patchGate=new Promise(resolve=>{release=resolve;});
    try{await model.selectOption('account-basic');await settings.getByRole('status').filter({hasText:'Saving…'}).waitFor();assert.equal(await page.locator('#message-form [type=submit]').isDisabled(),true,'sending waits for a model change to be acknowledged');}finally{release();state.patchGate=null;}
    await trigger.filter({hasText:'Account basic'}).waitFor();assert.equal(await settings.getByRole('switch',{name:'Fast mode'}).count(),0);assert.equal(await settings.getByRole('combobox',{name:'Reasoning effort'}).count(),0);
    await settings.getByRole('button',{name:'Close model settings'}).click();await sendMessage(page);await page.locator('#message').filter({hasText:''}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#message').value==='');
    const accepted=state.runs.get(BOT_A).find(run=>run.model==='account-basic');assert.ok(accepted);assert.equal(accepted.fast,false);assert.equal(accepted.reasoningEffort,undefined,'unsupported reasoning is cleared when choosing another model');
    await page.reload();await trigger.filter({hasText:'Account basic'}).waitFor();assert.equal(await page.locator('#selected-avatar').getAttribute('data-agent-color'),color);
    await openPanel(page,'runs');await page.locator(`[data-run-id="${accepted.id}"] [data-run-model="account-basic"]`).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  },{viewport,...(viewport.width<760?{isMobile:true,hasTouch:true}:{})});
});

test('unavailable model catalogs keep the saved model readable and allow a deliberate retry',async()=>{
  await withPage(async({page,state,login})=>{
    state.modelsError={code:'catalog_unavailable',message:'The model catalog is temporarily unavailable.'};await login();
    const trigger=page.getByRole('button',{name:/^Model settings:/});await trigger.click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true});await settings.getByRole('alert').filter({hasText:'temporarily unavailable'}).waitFor();
    const model=settings.getByRole('combobox',{name:'Model',exact:true});assert.equal(await model.isDisabled(),true);assert.equal(await model.inputValue(),'gpt-6.1-sol');assert.equal(await model.locator('option').count(),1);assert.equal(await settings.getByRole('switch').count(),0);
    state.modelsError=null;await settings.getByRole('button',{name:'Try again'}).click();await page.waitForFunction(()=>!document.querySelector('.timber-model-popover select').disabled);assert.equal(await model.locator('option').count(),1);
    await page.keyboard.press('Escape');await settings.waitFor({state:'hidden'});
    // Radix restores focus in a deferred unmount callback, after the panel hides.
    await trigger.and(page.locator(':focus')).waitFor({timeout:3000});
    assert.equal(await trigger.evaluate(node=>node===document.activeElement),true,'Escape restores keyboard focus to the settings control');
  });
});

test('disconnecting ChatGPT immediately makes model controls read-only',async()=>{
  await withPage(async({page,login})=>{
    await page.route('**/v1/connections/chatgpt',route=>route.request().method()==='DELETE'?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,status:'disconnected',revoked:true})}):route.continue());
    await login();await page.locator('#settings-button').click();await page.locator('#disconnect-chatgpt').click();await page.locator('#chatgpt-status').filter({hasText:'Not connected'}).waitFor();await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await page.getByRole('button',{name:/^Model settings:/}).click();const settings=page.getByRole('dialog',{name:'Model settings',exact:true});await settings.getByText('Connect ChatGPT in Settings to choose a model.',{exact:true}).waitFor();
    assert.equal(await settings.getByRole('combobox',{name:'Model',exact:true}).isDisabled(),true);assert.equal(await settings.getByRole('switch',{name:'Fast mode'}).count(),0);
  });
});

test('ChatGPT verification shows the model confirmed by the account rather than a fixed default',async()=>{
  await withPage(async({page,login})=>{
    let verified=0;await page.route('**/v1/connections/chatgpt/verify',route=>{assert.equal(route.request().method(),'POST');verified++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,model:'gpt-6-astra'})});});
    await login();await page.locator('#settings-button').click();await page.locator('#verify-chatgpt').click();await page.locator('#chatgpt-verification').filter({hasText:'Verified: gpt-6-astra completed a real request.'}).waitFor();assert.equal(verified,1);assert.equal(await page.locator('#chatgpt-error').innerText(),'');
  });
});

test('create and edit bot forms share the account model catalog and temporary agents show their own model',async()=>{
  await withPage(async({page,state,login})=>{
    state.modelCatalog.models.push({id:'account-reviewer',name:'Account reviewer',provider:'openai',reasoningEfforts:['high','xhigh'],defaultReasoningEffort:'high',supportsFast:true});
    const stamp=new Date().toISOString(),agent={id:'model-child',name:'Specialist',task:'Use the selected model for this review.',parentOperationId:'model-parent',operationId:'model-child-op',status:'completed',model:'account-reviewer',reasoningEffort:'xhigh',fast:true,createdAt:stamp,updatedAt:stamp};
    state.agents.set(BOT_A,[agent]);await login();
    const pill=page.locator(`[data-agent-created="${agent.id}"]`);await pill.locator('[data-model="account-reviewer"]').waitFor();await pill.getByRole('button',{name:'Open Specialist conversation',exact:true}).click();
    await page.locator(`[data-agent-model="account-reviewer"]`).filter({hasText:'xhigh reasoning · Fast'}).waitFor();await openPanel(page,'conversation');
    await openBotEditor(page);await page.locator('#edit-model').selectOption('account-reviewer');assert.equal(await page.locator('#edit-reasoning').inputValue(),'high');await page.locator('#edit-fast').check();await page.locator('#edit-form [type=submit]').click();await page.locator('#edit-dialog').waitFor({state:'hidden'});
    assert.equal(state.bots.find(bot=>bot.id===BOT_A).model,'account-reviewer');assert.equal(state.bots.find(bot=>bot.id===BOT_A).fast,true);
    await page.locator('#new-bot').click();await page.locator('#bot-name').fill('Model-aware helper');await page.locator('#bot-model').selectOption('account-reviewer');await page.locator('#bot-reasoning').selectOption('xhigh');await page.locator('#bot-fast').check();await page.locator('#create-form [type=submit]').click();await page.locator('#bot-dialog').waitFor({state:'hidden'});
    const created=state.bots.find(bot=>bot.name==='Model-aware helper');assert.ok(created);assert.equal(created.model,'account-reviewer');assert.equal(created.reasoningEffort,'xhigh');assert.equal(created.fast,true);
    await page.reload();await page.locator('#selected-avatar .timber-model-badge[data-model="account-reviewer"]').waitFor();
  });
});

for(const width of [1440,390])test(`model failures show actionable safe diagnostics from live and historical events at ${width}px`,async()=>{
  await withPage(async({page,state,login})=>{
    const bot=state.bots.find(item=>item.id===BOT_A);Object.assign(bot,{name:'Polibot',model:'gpt-6-astra',reasoningEffort:'high',fast:true});state.modelCatalog.models.push({id:'gpt-6-astra',name:'GPT-6 Astra',provider:'openai',reasoningEfforts:['high'],defaultReasoningEffort:'high',supportsFast:true});
    const stamp=new Date().toISOString(),run={id:'model-diagnostic-run',botId:BOT_A,operationId:'model-diagnostic-operation',model:bot.model,reasoningEffort:'high',fast:true,status:'running',createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'model-diagnostic-request',botId:BOT_A,runId:run.id,role:'user',text:'Review the project.',createdAt:stamp}]);await login();
    state.emit(BOT_A,'run.failed',{reason:'model_error',errorCode:'model_fast_unsupported',publicMessage:'Private provider detail must never be rendered.'},run.id);Object.assign(run,{status:'failed',error:'The model request failed before an answer completed.',updatedAt:new Date(Date.now()+1000).toISOString()});state.emit(BOT_A,'run.updated',{run},run.id);
    const notice=page.locator(`[data-run-outcome="${run.id}"]`);await notice.getByText('The provider rejected Fast mode for this request. Turn off Fast or choose another supported model.',{exact:true}).waitFor();
    assert.equal(await notice.getByRole('button',{name:'Continue',exact:true}).count(),0);assert.equal(await notice.getByRole('button',{name:'Try again',exact:true}).count(),0);assert.equal(await page.getByText('Private provider detail must never be rendered.',{exact:true}).count(),0);assert.equal(sentMessages(state,BOT_A).length,0);
    await page.reload();await notice.getByRole('button',{name:'Review model settings',exact:true}).waitFor();await notice.locator('summary').click();await notice.getByText('model_fast_unsupported',{exact:true}).waitFor();await notice.getByText('gpt-6-astra · high reasoning · Fast',{exact:true}).waitFor();
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-model-failure-${width}.png`,animations:'disabled'});
    await page.locator('#message').fill('Preserve this draft');await notice.getByRole('button',{name:'Review model settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Model settings',exact:true});await settings.waitFor();assert.equal(await settings.getByRole('combobox',{name:'Model',exact:true}).inputValue(),'gpt-6-astra');assert.equal(await settings.getByRole('switch',{name:'Fast mode'}).isChecked(),true);assert.equal(await page.locator('#message').inputValue(),'Preserve this draft');assert.equal(sentMessages(state,BOT_A).length,0,'reviewing settings never retries the failed request');
  },{viewport:{width,height:900},...(width<760?{isMobile:true,hasTouch:true}:{})});
});

test('permanent model failures route to connection or context and do not offer unchanged continuation',async()=>{
  for(const [errorCode,target]of [['chatgpt_not_connected','Open Settings'],['model_context_length_exceeded','Review context'],['model_request_invalid',null],['chatgpt_allowance_exhausted',null]])await withPage(async({page,state,login})=>{
    const stamp=new Date().toISOString(),run={id:'permanent-failure',botId:BOT_A,operationId:'permanent-operation',status:'failed',error:'A safe older fallback.',errorCode,createdAt:stamp,updatedAt:stamp};state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'permanent-request',botId:BOT_A,runId:run.id,role:'user',text:'Original task',createdAt:stamp}]);await login();const notice=page.locator(`[data-run-outcome="${run.id}"]`);await notice.waitFor();assert.equal(await notice.getByRole('button',{name:/^(Continue|Try again)$/}).count(),0);
    if(target){await notice.getByRole('button',{name:target,exact:true}).click();if(target==='Open Settings')await page.locator('#settings-dialog').waitFor();else await page.getByRole('dialog',{name:'Context and memory',exact:true}).waitFor();}
    assert.equal(sentMessages(state,BOT_A).length,0);
  });
});

test('transient model failure continuation preserves recorded results and starts only after an explicit click',async()=>{
  await withPage(async({page,state,login})=>{
    const stamp=new Date().toISOString(),run={id:'transient-failure',botId:BOT_A,operationId:'transient-operation',status:'failed',error:'A safe older fallback.',errorCode:'model_connection_interrupted',createdAt:stamp,updatedAt:stamp};state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'transient-request',botId:BOT_A,runId:run.id,role:'user',text:'Inspect the saved build result.',createdAt:stamp}]);state.emit(BOT_A,'tool.completed',{operationId:'preserved-build',toolName:'exec',result:{status:'completed',output:'Build passed.',exitCode:0}},run.id);await login();
    const notice=page.locator(`[data-run-outcome="${run.id}"]`);await notice.getByText(MODEL_FAILURES.model_connection_interrupted,{exact:true}).waitFor();assert.equal(sentMessages(state,BOT_A).length,0);assert.equal(await page.locator('[data-tool-operation-id="preserved-build"][data-tool-status="completed"]').count(),1);
    const accepted=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/messages'));await notice.getByRole('button',{name:'Continue',exact:true}).click();await accepted;const sent=sentMessages(state,BOT_A);assert.equal(sent.length,1);assert.notEqual(sent[0].body.operationId,run.operationId);assert.match(sent[0].body.text,/Inspect the saved build result/);assert.match(sent[0].body.text,/do not repeat completed work/);assert.equal(state.actions.length,0);
  });
});

for(const width of [1440,390])test(`ChatGPT allowance failure directs to usage and never blindly continues at ${width}px`,async()=>{
  await withPage(async({page,context,state,login})=>{
    const stamp=new Date().toISOString(),run={id:'quota-failure',botId:BOT_A,operationId:'quota-operation',status:'failed',admissionRetryable:true,error:'The model request failed before an answer completed.',...(width===1440?{errorCode:'chatgpt_allowance_exhausted'}:{}),createdAt:stamp,updatedAt:stamp};
    state.runs.set(BOT_A,[run]);state.messages.set(BOT_A,[{id:'quota-request',botId:BOT_A,runId:run.id,role:'user',text:'Continue the project.',createdAt:stamp}]);if(width===390)state.emit(BOT_A,'run.failed',{errorCode:'chatgpt_allowance_exhausted'},run.id);
    await context.route('https://chatgpt.com/settings/usage',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>ChatGPT usage fixture</title><p>Usage details</p>'}));
    await login();const notice=page.locator(`[data-run-outcome="${run.id}"]`);await notice.getByText('ChatGPT usage limit reached',{exact:true}).waitFor();await notice.getByText(MODEL_FAILURES.chatgpt_allowance_exhausted,{exact:true}).waitFor();assert.match(await notice.innerText(),/reset/i);assert.equal(await notice.getByRole('button',{name:/^(Continue|Try again|Retry sending)$/}).count(),0);assert.equal(sentMessages(state,BOT_A).length,0);
    await page.reload();await notice.getByText('ChatGPT usage limit reached',{exact:true}).waitFor();await page.locator('#message').fill('Keep this draft for later');
    const link=notice.getByRole('link',{name:'Open ChatGPT usage',exact:true});assert.equal(await link.getAttribute('href'),'https://chatgpt.com/settings/usage');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-quota-${width}.png`,animations:'disabled'});
    const popupReady=page.waitForEvent('popup');await link.click();const popup=await popupReady;await popup.waitForLoadState();assert.equal(popup.url(),'https://chatgpt.com/settings/usage');assert.equal(await popup.evaluate(()=>window.opener===null),true);await popup.close();assert.equal(await page.locator('#message').inputValue(),'Keep this draft for later');assert.equal(sentMessages(state,BOT_A).length,0);
  },{viewport:{width,height:900},...(width<760?{isMobile:true,hasTouch:true}:{})});
});
