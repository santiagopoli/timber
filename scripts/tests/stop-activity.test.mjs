import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {mergeToolResult, mergeToolStatus, runOutcomes, toolActivityState, toolFailureSummary} from '../../apps/console/src/cancellation-presentation.ts';
import {createConsoleFixture, TEST_TOKEN, BOT_A} from './console-fixture.mjs';

test('settled tool effects survive later cancellation and preserve saved checkpoints', () => {
  const completed = {status: 'completed', output: 'Finished once\n', exitCode: 0};
  for (const status of ['running', 'cancelled', 'failed', 'interrupted']) {
    assert.equal(mergeToolStatus('completed', status), 'completed');
    assert.deepEqual(mergeToolResult(completed, {status, error: 'Late cancellation'}), completed);
  }
  assert.equal(mergeToolStatus('failed', 'cancelled'), 'failed');
  assert.deepEqual(mergeToolResult({status: 'running'}, {status: 'cancelled', output: 'Partial\n'}), {status: 'cancelled', output: 'Partial\n'});
  const saved = {...completed, checkpointStatus: 'saved', checkpointId: 'snapshot-one'};
  assert.deepEqual(mergeToolResult(saved, {...completed, checkpointStatus: 'pending', error: 'Saving files failed'}, {snapshot: true}), {...saved, error: undefined});
  assert.deepEqual(mergeToolResult({status: 'running', error: 'Old diagnostic', exitCode: 7}, {status: 'completed', output: 'New snapshot'}, {snapshot: true}), {status: 'completed', output: 'New snapshot'});
});

test('Stop cancels unfinished tools while completed effects and live processes keep their recorded outcomes', () => {
  const cancelledRun = {status: 'cancelled'};
  const finished = {returned: true, result: {status: 'completed', output: 'Saved', exitCode: 0}, data: {}};
  assert.equal(toolActivityState(finished, cancelledRun).status, 'completed');
  assert.equal(toolActivityState({returned: true, data: {}}, cancelledRun).text, 'Returned');
  const pending = toolActivityState({returned: false, data: {}}, cancelledRun);
  assert.equal(pending.cancelled, true); assert.equal(pending.failed, false); assert.equal(pending.text, 'Cancelled');
  const process = {returned: true, result: {status: 'running', processId: 'active-process'}, data: {}};
  assert.equal(toolActivityState(process, cancelledRun).text, 'Stopping…');
  assert.equal(toolActivityState(process, cancelledRun).status, 'running');
  const cancelled = toolActivityState({...process, result: {...process.result, status: 'cancelled'}}, cancelledRun);
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.failed, false);
  assert.equal(toolFailureSummary({status: 'cancelled', error: 'The action was cancelled.'}, cancelled), undefined);
  const failedResult = {status: 'failed', exitCode: 9};
  const failed = toolActivityState({returned: true, result: failedResult, data: {}}, cancelledRun);
  assert.equal(toolFailureSummary(failedResult, failed), 'Command exited with code 9.');
  assert.equal(toolFailureSummary({...failedResult, error: 'Permission denied.'}, failed), 'Permission denied.');
  const unknown = toolActivityState({returned: false, data: {}}, {status: 'completed'});
  assert.equal(unknown.text, 'Outcome unconfirmed'); assert.equal(unknown.failed, false);
  assert.equal(toolFailureSummary(undefined, unknown), 'No result was recorded. Inspect its effects before retrying.');
});

test('one explicit Stop groups root, child and native continuation cancellations without hiding genuine errors', () => {
  const cancellation = {id: 'stop-group', requestedRunId: 'root'};
  const runs = [{id: 'root', status: 'cancelled', cancellation},
    ...Array.from({length: 6}, (_, index) => ({id: `continuation-${index}`, status: 'cancelled', cancellation})),
    {id: 'child', subagentId: 'agent-one', parentRunId: 'root', status: 'cancelled', cancellation},
    {id: 'actual-failure', status: 'failed', cancellation, error: 'The service stopped responding.'},
    {id: 'actual-interruption', status: 'interrupted', error: 'The run was stopped before an answer completed.'}];
  const events = [{type: 'run.cancellation.requested', createdAt: '2026-10-09T12:00:00.000Z', data: {cancellation}}];
  const outcomes = runOutcomes(runs, events);
  assert.equal(outcomes.filter(outcome => outcome.kind === 'stopped').length, 1);
  assert.equal(outcomes.find(outcome => outcome.kind === 'stopped').run.id, 'root');
  assert.deepEqual(outcomes.filter(outcome => outcome.kind === 'failure').map(outcome => outcome.run.id), ['actual-failure', 'actual-interruption']);
  assert.equal(runOutcomes(runs, events, 'continuation-2').at(0).run.id, 'continuation-2');
  assert.equal(runOutcomes(runs, events, 'child').at(0).run.id, 'child');
  assert.equal(runOutcomes(runs, events, 'unrelated').length, 0);
});

test('Stop on a completed owner is visible without changing its result; legacy grouping requires recorded ancestry', () => {
  const cancellation = {id: 'background-stop', requestedRunId: 'done'};
  const outcomes = runOutcomes([{id: 'done', status: 'completed'}], [{type: 'run.cancellation.requested', createdAt: '2026-10-09T12:00:00.000Z', data: {cancellation}}]);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].kind, 'stopped'); assert.equal(outcomes[0].run.status, 'completed');
  const legacy = runOutcomes([{id: 'root', status: 'cancelled'}, {id: 'followup', parentRunId: 'root', status: 'cancelled'}, {id: 'separate', status: 'cancelled'}], []);
  assert.deepEqual(legacy.map(outcome => outcome.run.id), ['root', 'separate']);
});

let browser;
after(async () => {await browser?.close();});
async function withPage(work, width = 1440) {
  browser ??= await chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
  const fixture = await createConsoleFixture();
  const context = await browser.newContext({viewport: {width, height: 1050}, colorScheme: 'light'});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  const login = async () => {
    await page.goto(fixture.url); await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click(); await page.locator('#app').waitFor({state: 'visible'});
    if (width <= 760) await page.locator('.bot-item').first().click();
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
  };
  try {await work({...fixture, page, login}); assert.deepEqual(errors, []); assert.deepEqual(fixture.state.failures, []);}
  finally {await context.close(); await fixture.close();}
}
const makeRun = (id, status, extra = {}) => ({id, botId: BOT_A, operationId: `${id}-operation`, status,
  createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(), ...extra});
const userMessage = run => ({id: `${run.id}-request`, botId: BOT_A, runId: run.id, role: 'user', text: `Request for ${run.id}.`, createdAt: run.createdAt});

test('browser: one quiet Stop notice, completed tools preserved, and genuine tool failures explained inline', async () => {
  for (const width of [1440, 390]) await withPage(async ({state, page, login}) => {
    const run = makeRun('stop-display-root', 'running');
    const other = makeRun('real-failure', 'failed', {error: 'The service stopped responding.'});
    const unknown = makeRun('unknown-effect', 'completed');
    const joined = Array.from({length: 6}, (_, index) => makeRun(`joined-${index}`, 'running'));
    state.runs.set(BOT_A, [run, ...joined, other, unknown]);
    state.messages.set(BOT_A, [run, other, unknown].map(userMessage));
    const emit = (id, result, runId = run.id) => state.emit(BOT_A, 'tool.completed', {operationId: id, toolCallId: `call-${id}`, toolName: 'exec', input: {command: `printf ${id}`}, result}, runId);
    emit('finished-effect', {status: 'completed', output: 'Already saved\n', exitCode: 0});
    state.emit(BOT_A, 'tool.completed', {operationId: 'native-finished', toolName: 'read_file'}, run.id);
    emit('real-tool-error', {status: 'failed', error: 'Permission denied opening the requested file.', exitCode: 1});
    emit('exit-only-error', {status: 'failed', exitCode: 9});
    state.emit(BOT_A, 'tool.started', {operationId: 'unfinished-effect', toolName: 'read_file', input: {path: 'notes.md'}}, run.id);
    state.emit(BOT_A, 'tool.started', {operationId: 'unknown-result', toolName: 'exec', input: {command: 'some-command'}}, unknown.id);
    await login();
    const row = id => page.locator(`#messages [data-tool-operation-id="${id}"]`);
    await row('finished-effect').waitFor();
    const cancellation = {id: 'explicit-ui-stop', requestedRunId: run.id};
    state.emit(BOT_A, 'run.cancellation.requested', {cancellation}, run.id);
    for (const stopped of [run, ...joined]) {
      Object.assign(stopped, {status: 'cancelled', cancellation, error: 'The run was stopped before an answer completed.'});
      state.emit(BOT_A, 'run.updated', {run: stopped}, stopped.id);
    }
    emit('finished-effect', {status: 'cancelled', error: 'Late native abort'});
    state.emit(BOT_A, 'tool.completed', {operationId: 'native-finished', toolName: 'read_file', status: 'cancelled'}, run.id);
    emit('real-tool-error', {status: 'cancelled', error: 'Late native abort'});
    await page.locator('[data-task-outcome-kind="stopped"]').waitFor();
    assert.equal(await page.locator('[data-task-outcome-kind="stopped"]').count(), 1);
    assert.equal(await page.locator('.timber-task-outcome').count(), 1, 'only the genuine response failure remains');
    assert.match(await page.locator('.timber-task-outcome').innerText(), /The service stopped responding/);
    assert.doesNotMatch(await page.locator('[data-task-outcome-kind="stopped"]').innerText(), /interrupted|Continue|before an answer/);
    assert.equal(await row('finished-effect').getAttribute('data-tool-status'), 'completed');
    assert.equal(await row('finished-effect').locator('.timber-tool-status').getAttribute('aria-label'), 'Completed · exit 0');
    assert.match(await row('finished-effect').innerText(), /Already saved/);
    assert.equal(await row('native-finished').getAttribute('data-tool-status'), 'completed');
    assert.equal(await row('unfinished-effect').getAttribute('data-tool-status'), 'cancelled');
    assert.equal(await row('unfinished-effect').locator('.lucide-square').count(), 1);
    assert.equal(await row('unfinished-effect').locator('.lucide-circle-alert').count(), 0);
    assert.match(await row('unfinished-effect').locator('summary').innerText(), /Cancelled/);
    assert.doesNotMatch(await row('unfinished-effect').getAttribute('class'), /timber-tool-error/);
    assert.equal(await row('real-tool-error').getAttribute('data-tool-status'), 'failed');
    assert.match(await row('real-tool-error').locator('[data-tool-result-preview]').innerText(), /Permission denied opening the requested file/);
    assert.match(await row('exit-only-error').locator('[data-tool-result-preview]').innerText(), /Command exited with code 9/);
    assert.match(await row('unknown-result').locator('summary').innerText(), /Outcome unconfirmed/);
    assert.doesNotMatch(await row('unknown-result').getAttribute('class'), /timber-tool-error/);
    if (process.env.CONSOLE_SCREENSHOT_DIR) {
      await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true});
      await row('finished-effect').scrollIntoViewIfNeeded();
      await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/stop-activity-${width}.png`, animations: 'disabled'});
      await page.locator('[data-task-outcome-kind="stopped"]').scrollIntoViewIfNeeded();
      await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/stop-notice-${width}.png`, animations: 'disabled'});
    }
    await page.reload(); await page.locator('[data-task-outcome-kind="stopped"]').waitFor();
    assert.equal(await page.locator('[data-task-outcome-kind="stopped"]').count(), 1);
    assert.equal(await row('finished-effect').getAttribute('data-tool-status'), 'completed');
    assert.equal(await row('real-tool-error').getAttribute('data-tool-status'), 'failed');
  }, width);
});

test('browser: background command stays Stopping until cancellation receipt and then uses a neutral icon', async () => {
  await withPage(async ({state, page, login}) => {
    const run = makeRun('background-stop-owner', 'completed');
    state.runs.set(BOT_A, [run]); state.messages.set(BOT_A, [userMessage(run)]);
    const processId = 'background-stop-process';
    const update = (result, cancellationRequested = false) => state.emit(BOT_A, 'process.updated', {
      operationId: processId, processId, input: {command: 'python build.py'}, result, cancellationRequested,
    }, run.id);
    update({processId, status: 'running', output: 'Working\n'});
    await login();
    const row = page.locator(`#messages [data-tool-operation-id="${processId}"]`);
    await row.waitFor();
    update({processId, status: 'running', output: 'Working\n'}, true);
    await row.locator('[aria-label="Stopping…"]').waitFor();
    assert.equal(await row.getAttribute('data-tool-status'), 'running');
    update({processId, status: 'cancelled', output: 'Partial output retained\n', exitCode: -15, error: 'The action was cancelled.'});
    await row.locator('[aria-label="Cancelled · exit -15"]').waitFor();
    assert.equal(await row.locator('.lucide-square').count(), 1);
    assert.equal(await row.locator('.lucide-circle-alert').count(), 0);
    assert.equal(await row.locator('.timber-inline-error').count(), 0);
    assert.equal(await row.locator('.timber-tool-exit').count(), 0);
    assert.match(await row.innerText(), /Cancelled[\s\S]*Partial output retained/);
    assert.equal(run.status, 'completed');
  });
});

test('browser: authoritative process receipts resolve native aborts in root and child activity without rewriting settled effects', async () => {
  await withPage(async ({state, page, login}) => {
    const run = makeRun('receipt-authority-root', 'completed');
    const childRun = makeRun('receipt-authority-child', 'running', {parentRunId: run.id, subagentId: 'receipt-agent'});
    const agent = {id: 'receipt-agent', name: 'Receipt reviewer', task: 'Inspect process results.',
      parentOperationId: run.operationId, operationId: childRun.operationId, status: 'running', createdAt: run.createdAt, updatedAt: run.updatedAt};
    state.runs.set(BOT_A, [run, childRun]); state.agents.set(BOT_A, [agent]);
    state.messages.set(BOT_A, [userMessage(run)]); state.agentMessages.set(agent.id, []);
    const scopes = [{prefix: 'root', run, agentId: undefined}, {prefix: 'child', run: childRun, agentId: agent.id}];
    const wrapper = (scope, suffix, status) => {
      const operationId = `${scope.prefix}-${suffix}`;
      state.emit(BOT_A, scope.agentId ? 'subagent.tool.completed' : 'tool.completed', {
        ...(scope.agentId ? {subagentId: scope.agentId} : {}), operationId, toolCallId: `call-${operationId}`,
        toolName: 'exec', input: {command: `printf ${operationId}`}, status,
      }, scope.run.id);
    };
    const receipt = (scope, suffix, status, process = true) => {
      const operationId = `${scope.prefix}-${suffix}`;
      state.emit(BOT_A, `${scope.agentId ? 'subagent.' : ''}${process ? 'process.updated' : 'tool.completed'}`, {
        ...(scope.agentId ? {subagentId: scope.agentId} : {}), operationId, processId: operationId,
        toolCallId: `call-${operationId}`, toolName: 'exec', input: {command: `printf ${operationId}`},
        result: {operationId, processId: operationId, status, output: `Recorded ${status} ${operationId}\n`,
          ...(status === 'completed' ? {exitCode: 0} : status === 'failed' ? {exitCode: 2, error: 'Recorded process failure.'} : {})},
      }, scope.run.id);
    };
    for (const scope of scopes) {
      wrapper(scope, 'abort-then-completed', 'failed');
      wrapper(scope, 'abort-then-running', 'cancelled');
      receipt(scope, 'settled-completed', 'completed');
      receipt(scope, 'settled-failed', 'failed');
    }
    await login();
    const rootRow = suffix => page.locator(`#messages [data-tool-operation-id="root-${suffix}"]`);
    await rootRow('abort-then-completed').locator('[aria-label="Failed"]').waitFor();
    await rootRow('abort-then-running').locator('[aria-label="Cancelled"]').waitFor();
    for (const scope of scopes) {
      receipt(scope, 'abort-then-completed', 'completed');
      receipt(scope, 'abort-then-running', 'running', false);
      wrapper(scope, 'settled-completed', 'cancelled'); receipt(scope, 'settled-completed', 'failed');
      wrapper(scope, 'settled-failed', 'cancelled'); receipt(scope, 'settled-failed', 'completed');
    }
    await rootRow('abort-then-completed').locator('[aria-label="Completed · exit 0"]').waitFor();
    await rootRow('abort-then-running').locator('[aria-label="Running"]').waitFor();
    assert.equal(await rootRow('settled-completed').getAttribute('data-tool-status'), 'completed');
    assert.equal(await rootRow('settled-failed').getAttribute('data-tool-status'), 'failed');
    if (!await page.locator('#tab-agents').isVisible()) await page.locator('#panel-menu > summary').click();
    await page.locator('#tab-agents').click(); await page.locator(`[data-agent-id="${agent.id}"]`).click();
    const detail = page.locator(`[data-agent-detail="${agent.id}"]`);
    await detail.locator('.timber-agent-activity > summary').click();
    const childRow = suffix => detail.locator('.timber-agent-activity article').filter({has: page.locator('pre').filter({hasText: `printf child-${suffix}`})});
    await childRow('abort-then-completed').locator('[data-status="completed"]').waitFor();
    await childRow('abort-then-running').locator('[data-status="running"]').waitFor();
    assert.equal(await childRow('settled-completed').locator('[data-status]').getAttribute('data-status'), 'completed');
    assert.equal(await childRow('settled-failed').locator('[data-status]').getAttribute('data-status'), 'failed');
    for (const scope of scopes) receipt(scope, 'abort-then-running', 'completed');
    await childRow('abort-then-running').locator('[data-status="completed"]').waitFor();
    await page.reload(); await detail.locator('.timber-agent-activity > summary').click();
    assert.equal(await childRow('abort-then-completed').locator('[data-status]').getAttribute('data-status'), 'completed');
    assert.equal(await childRow('abort-then-running').locator('[data-status]').getAttribute('data-status'), 'completed');
    assert.equal(await childRow('settled-completed').locator('[data-status]').getAttribute('data-status'), 'completed');
    assert.equal(await childRow('settled-failed').locator('[data-status]').getAttribute('data-status'), 'failed');
  });
});
