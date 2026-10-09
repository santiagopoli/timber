/**
 * Actual production-bundle benchmark; build first. No timing pass thresholds.
 * CONSOLE_CHROMIUM_PATH=/usr/bin/chromium node --test scripts/tests/long-conversation-performance.test.mjs
 * Set LONG_CONVERSATION_BASELINE=1 to record an earlier build without requiring
 * the optimized render budget; LONG_CONVERSATION_RESULT=/tmp/before.json saves
 * metrics. CONSOLE_DIST selects an isolated build. Never rebuild while running.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN, BOT_A, BOT_B} from './console-fixture.mjs';

const MESSAGE_COUNT = 1200, UPDATES_PER_BATCH = 12, BATCHES = 3;
const BASELINE = process.env.LONG_CONVERSATION_BASELINE === '1';
const id = index => `long-history-${index}`;
const selector = index => `[data-message-id="${id(index)}"]`;
const stamp = index => new Date(Date.UTC(2026, 9, 5, 10, 0, index)).toISOString();
function markdown(index) {
  const prefix = `History item ${index}: unique-history-marker-${index}`;
  return [
    `${prefix}\n\n**Persistent conversation** with *emphasis*, [a safe link](https://example.com/history/${index}) and inline \`code_${index}\`.`,
    `${prefix}\n\n- First finding ${index}\n- Second finding\n\n> A preserved historical quotation.`,
    `${prefix}\n\n\`\`\`js\nconst item = ${index};\nconsole.log(item);\n\`\`\`\n\nA multiline **answer**.`,
    `${prefix}\n\n| Field | Value |\n| --- | --- |\n| Index | ${index} |\n| Saved | Yes |`,
    `${prefix}\n\n### Findings\n\n1. Keep all history\n2. Read and copy old answers\n\n---\n\nUnicode: café 日本語.`,
  ][index % 5];
}
// Supported, test-only React DevTools hook. PerformedWork (bit 1) on a
// text-bearing function fiber measures rendering, NOT just DOM mutations (a
// redundant Markdown render often makes no DOM changes). No minified names are
// assumed. A genuine historical edit below verifies probe sensitivity first.
function installRenderProbe() {
  const probe = globalThis.__longHistoryProbe = {enabled: false, injected: 0, commits: 0, historyTextRenders: 0, renderedHistoryIds: [], historyMutationRecords: 0, longTasks: [], frameGaps: []};
  let previousTextFibers = new WeakSet();
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject() {probe.injected++; return probe.injected;},
    onCommitFiberRoot(_renderer, root) {
      if (probe.enabled) probe.commits++;
      const nextTextFibers = new WeakSet(), stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop(), text = fiber.memoizedProps?.text;
        if ([0, 14, 15].includes(fiber.tag) && typeof text === 'string' && text.startsWith('History item ')) {
          nextTextFibers.add(fiber);
          // A bailed-out parent can reuse child fibers with old flags. Do not
          // count those reused objects as new render work.
          if (probe.enabled && !previousTextFibers.has(fiber) && (fiber.flags & 1)) {
            probe.historyTextRenders++;
            const marker = /^History item (\d+):/.exec(text)?.[1];
            if (marker && !probe.renderedHistoryIds.includes(marker)) probe.renderedHistoryIds.push(marker);
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      previousTextFibers = nextTextFibers;
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  };
  try {new PerformanceObserver(list => {if (probe.enabled) probe.longTasks.push(...list.getEntries().map(entry => entry.duration));}).observe({type: 'longtask', buffered: false});} catch {}
  let previous;
  const frame = now => {if (probe.enabled && previous !== undefined) probe.frameGaps.push(now - previous); previous = now; requestAnimationFrame(frame);};
  requestAnimationFrame(frame);
  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(records => {
      if (!probe.enabled) return;
      for (const record of records) {
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (element?.closest('[data-message-id^="long-history-"]')) probe.historyMutationRecords++;
      }
    }).observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
  });
}
async function settle(page) {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
async function resetProbe(page) {
  await settle(page);
  await page.evaluate(() => Object.assign(globalThis.__longHistoryProbe, {enabled: true, commits: 0, historyTextRenders: 0, renderedHistoryIds: [], historyMutationRecords: 0, longTasks: [], frameGaps: []}));
}
async function readProbe(page) {
  await settle(page);
  return page.evaluate(() => {globalThis.__longHistoryProbe.enabled = false; return structuredClone(globalThis.__longHistoryProbe);});
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {count: values.length, min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, max: sorted.at(-1) ?? 0, total: values.reduce((sum, value) => sum + value, 0)};
}
async function moveToHistory(page, index) {
  await page.locator('#messages').evaluate((node, messageId) => {
    node.dispatchEvent(new WheelEvent('wheel', {deltaY: -600, bubbles: true}));
    const target = node.querySelector(`[data-message-id="${messageId}"]`);
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - 80;
  }, id(index));
  await settle(page);
}
async function anchor(page, index) {return page.locator(selector(index)).evaluate(node => ({top: node.getBoundingClientRect().top, scrollTop: document.querySelector('#messages').scrollTop, height: node.getBoundingClientRect().height}));}
async function selectBot(page, botId) {
  const item = page.locator(`[data-bot-id="${botId}"]`);
  if (!await item.isVisible()) await page.locator('#mobile-back').click();
  await item.click();
  await page.locator('#selected-name').filter({hasText: botId === BOT_A ? 'Ada' : 'Linus'}).waitFor();
  await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
}

test('1200 mixed-Markdown messages stay seamless while live updates perform bounded history render work', async () => {
  const fixture = await createConsoleFixture();
  const browser = await chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
  const context = await browser.newContext({viewport: {width: 1440, height: 1050}});
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(180000); // readiness only, not a performance budget
  page.on('pageerror', error => errors.push(error.message));
  const metrics = {mode: BASELINE ? 'baseline' : 'optimized', messages: MESSAGE_COUNT, markdownVariants: 5, updatesPerBatch: UPDATES_PER_BATCH, batches: BATCHES, viewport: {width: 1440, height: 1050}, browser: browser.version()};
  try {
    const dist = resolve(process.env.CONSOLE_DIST || 'apps/console/dist');
    metrics.htmlSHA256 = createHash('sha256').update(await readFile(resolve(dist, 'index.html'))).digest('hex');
    const history = Array.from({length: MESSAGE_COUNT}, (_, index) => ({id: id(index), botId: BOT_A, runId: `history-run-${Math.floor(index / 2)}`, role: index % 2 ? 'assistant' : 'user', text: markdown(index), createdAt: stamp(index)}));
    fixture.state.messages.set(BOT_A, history);
    fixture.state.messages.set(BOT_B, [{id: 'other-bot-history', botId: BOT_B, role: 'assistant', text: 'Only Linus owns this history.', createdAt: stamp(0)}]);
    fixture.state.runs.set(BOT_A, Array.from({length: 12}, (_, index) => ({id: `history-run-${index * 50}`, botId: BOT_A, operationId: `history-operation-${index}`, status: 'completed', createdAt: stamp(index * 100), updatedAt: stamp(index * 100 + 99)})).reverse());
    for (let index = 0; index < 12; index++) {
      const event = fixture.state.emit(BOT_A, 'tool.started', {toolCallId: `history-tool-${index}`, toolName: 'exec', input: {command: `printf history-${index}`}}, `history-run-${index * 50}`);
      event.createdAt = stamp(index * 100 + 2);
      const completed = fixture.state.emit(BOT_A, 'tool.completed', {toolCallId: `history-tool-${index}`, toolName: 'exec', result: {status: 'completed', output: `history-${index}`, exitCode: 0}}, `history-run-${index * 50}`);
      completed.createdAt = stamp(index * 100 + 3);
    }
    metrics.initialEvents = fixture.state.events.length;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(fixture.url).origin});
    await page.addInitScript(installRenderProbe);
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    const loadStart = performance.now();
    await page.locator('#connect-form button').click();
    await page.locator(selector(MESSAGE_COUNT - 1)).waitFor({state: 'attached'});
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
    await settle(page);
    metrics.initialLoadMs = performance.now() - loadStart;
    console.log(`LONG_HISTORY_STAGE initial ${metrics.initialLoadMs.toFixed(1)}ms`);
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), MESSAGE_COUNT, 'no truncation/DOM virtualization: all history remains browser-find/copy accessible');
    assert.deepEqual(await page.locator('[data-message-id^="long-history-"]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), history.map(message => message.id), 'complete transcript order');
    assert.equal(await page.getByRole('button', {name: /load (?:more|older)|show older messages/i}).count(), 0, 'no load-more step');
    assert.equal(await page.evaluate(() => globalThis.__longHistoryProbe.injected > 0), true, 'production React attached the render probe');
    metrics.historyAccessMs = [];
    for (const index of [0, 600, 1199]) {
      const start = performance.now();
      await moveToHistory(page, index);
      const message = page.locator(selector(index));
      assert.ok(await message.isVisible());
      await message.getByRole('button', {name: 'Copy message', exact: true}).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), history[index].text, 'old/middle/latest copy preserve exact Markdown');
      metrics.historyAccessMs.push(performance.now() - start);
    }
    // Let legitimate local Copy feedback timers finish before measuring only
    // stream/draft-driven historical render work (not copy-state renders).
    await page.waitForFunction(() => ![...document.querySelectorAll('.timber-copy-feedback')].some(node => node.textContent === 'Copied'));
    assert.equal(await page.evaluate(() => window.find('unique-history-marker-0', false, false, true)), true, 'native browser find reaches oldest message');
    await page.evaluate(() => getSelection()?.removeAllRanges());
    // Actual transcript edit must render: detects broken instrumentation or
    // over-aggressive memoization before testing zero redundant history work.
    await moveToHistory(page, 600);
    await resetProbe(page);
    history[600] = {...history[600], text: `${history[600].text}\n\nHistorical edit sensitivity marker.`};
    fixture.state.messages.set(BOT_A, history);
    fixture.state.emit(BOT_A, 'message.created', {message: history[600]}, history[600].runId);
    await page.locator(selector(600)).filter({hasText: 'Historical edit sensitivity marker.'}).waitFor({state: 'attached'});
    metrics.editSensitivity = await readProbe(page);
    console.log(`LONG_HISTORY_STAGE edit sensitivity renders ${metrics.editSensitivity.historyTextRenders}`);
    assert.ok(metrics.editSensitivity.historyTextRenders > 0, 'probe detects genuine historical text change');
    const run = {id: 'long-live-run', botId: BOT_A, operationId: 'long-live-operation', status: 'running', createdAt: stamp(1300), updatedAt: stamp(1300)};
    fixture.state.runs.get(BOT_A).unshift(run);
    fixture.state.emit(BOT_A, 'run.updated', {run}, run.id);
    let streamText = 'Live **response** starts.\n\n';
    fixture.state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: streamText}, run.id);
    await page.locator('#streaming-text').filter({hasText: 'response starts'}).waitFor({state: 'attached'});
    await moveToHistory(page, 600);
    const before = await anchor(page, 600);
    metrics.streamBatches = [];
    const typed = 'Typing while reading history; keep the draft and caret.';
    await resetProbe(page);
    const typingStart = performance.now();
    await page.locator('#message').pressSequentially(typed, {timeout: 180000});
    metrics.typingMs = performance.now() - typingStart;
    metrics.typingRenderWork = await readProbe(page);
    console.log(`LONG_HISTORY_STAGE typing ${metrics.typingMs.toFixed(1)}ms renders ${metrics.typingRenderWork.historyTextRenders}`);
    assert.equal(await page.locator('#message').inputValue(), typed);
    assert.equal(await page.locator('#message').evaluate(node => node.selectionStart), typed.length, 'caret survives updates');
    const afterTyping = await anchor(page, 600);
    assert.ok(Math.abs(afterTyping.top - before.top) <= 2, `typing must not move middle-history anchor (${before.top} -> ${afterTyping.top})`);
    for (let batch = 0; batch < BATCHES; batch++) {
      await resetProbe(page);
      const latencies = [], start = performance.now();
      for (let update = 0; update < UPDATES_PER_BATCH; update++) {
        const marker = `batch-${batch}-update-${update}`;
        const delta = `\n\n${marker}: a **streamed** finding with \`code\`.`;
        streamText += delta;
        const sent = performance.now();
        fixture.state.emit(BOT_A, 'message.delta', {delta}, run.id);
        // Await each distinct update: 36 real renders, not one burst that can
        // be collapsed into a single render by React/event-loop batching.
        await page.waitForFunction(expected => document.querySelector('#streaming-text')?.textContent.includes(expected), marker);
        await settle(page);
        latencies.push(performance.now() - sent);
      }
      const work = await readProbe(page);
      metrics.streamBatches.push({wallMs: performance.now() - start, updateLatencyMs: distribution(latencies), ...work, longTaskMs: distribution(work.longTasks), frameGapMs: distribution(work.frameGaps)});
      console.log(`LONG_HISTORY_STAGE batch ${batch} renders ${work.historyTextRenders}`);
      const after = await anchor(page, 600);
      assert.ok(Math.abs(after.top - before.top) <= 2 && Math.abs(after.scrollTop - afterTyping.scrollTop) <= 2, 'streaming must not move a history reader or pull them to latest');
      assert.equal(await page.locator('#message').inputValue(), typed, 'stream deltas preserve draft');
    }
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), MESSAGE_COUNT);
    assert.equal(await page.locator('#message').evaluate(node => document.activeElement === node && node.selectionStart === node.value.length), true, 'streaming preserves focus/caret');
    await page.getByRole('button', {name: 'Jump to latest message'}).click();
    await settle(page);
    await page.waitForFunction(() => {const node = document.querySelector('#messages'); return node.scrollHeight - node.clientHeight - node.scrollTop <= 4;});
    const lastDelta = '\n\nLatest-follow-marker after history browsing.\n\n```sh\npwd\n```';
    streamText += lastDelta;
    fixture.state.emit(BOT_A, 'message.delta', {delta: lastDelta}, run.id);
    await page.locator('#streaming-text').filter({hasText: 'Latest-follow-marker'}).waitFor({state: 'attached'});
    await settle(page);
    assert.ok(await page.locator('#messages').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 4), 'latest-follow tracks stream growth');
    await page.getByRole('button', {name: 'Copy response so far', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), streamText);
    const final = {id: 'long-live-final', botId: BOT_A, runId: run.id, role: 'assistant', text: streamText, createdAt: stamp(1301)};
    fixture.state.messages.get(BOT_A).push(final);
    fixture.state.emit(BOT_A, 'message.created', {message: final}, run.id);
    run.status = 'completed'; run.updatedAt = stamp(1301);
    fixture.state.emit(BOT_A, 'run.updated', {run}, run.id);
    await page.locator('[data-message-id="long-live-final"]').waitFor({state: 'attached'});
    await page.locator('#streaming-message').waitFor({state: 'detached'});
    assert.equal(await page.locator('[data-message-id="long-live-final"]').count(), 1);
    const switchStart = performance.now();
    await selectBot(page, BOT_B);
    await page.locator('[data-message-id="other-bot-history"]').waitFor({state: 'attached'});
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), 0, 'bot switch isolates histories');
    assert.equal(await page.locator('#message').inputValue(), '');
    fixture.state.emit(BOT_A, 'message.delta', {delta: 'Foreign late delta must not appear.'}, run.id);
    assert.equal(await page.locator('#streaming-message').count(), 0);
    await selectBot(page, BOT_A);
    await page.locator('[data-message-id="long-live-final"]').waitFor({state: 'attached'});
    metrics.roundTripBotSwitchMs = performance.now() - switchStart;
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), MESSAGE_COUNT, 'switch back restores all history');
    assert.equal(await page.locator('#message').inputValue(), typed, 'draft remains bot-scoped');
    assert.equal(await page.locator('[data-message-id="other-bot-history"]').count(), 0);
    assert.equal(await page.locator('#streaming-message').count(), 0, 'completed run stays completed after switching');
    await moveToHistory(page, 0);
    await page.locator(selector(0)).getByRole('button', {name: 'Copy message', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), history[0].text, 'oldest Markdown copy survives streaming/switch');
    metrics.messageReads = fixture.state.calls.filter(call => call.method === 'GET' && /\/messages(?:\?|$)/.test(call.path)).map(call => call.path);
    // Background archive transport may page; it must never require a user load-more step.
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(fixture.state.failures, [], 'fixture requests succeeded');
    metrics.totalStreamHistoryTextRenders = metrics.streamBatches.reduce((sum, batch) => sum + batch.historyTextRenders, 0);
    console.log(`LONG_HISTORY_METRICS ${JSON.stringify(metrics)}`);
    if (process.env.LONG_CONVERSATION_RESULT) await writeFile(process.env.LONG_CONVERSATION_RESULT, `${JSON.stringify(metrics, null, 2)}\n`);
    if (!BASELINE) {
      assert.equal(metrics.totalStreamHistoryTextRenders, 0, 'unchanged historical Markdown/copy text components must not re-render on stream-only updates');
      assert.equal(metrics.typingRenderWork.historyTextRenders, 0, 'typing must not re-render unchanged historical Markdown/copy text components');
      assert.ok(metrics.streamBatches.every(batch => batch.commits >= UPDATES_PER_BATCH), 'each distinct awaited delta commits actual rendering');
    }
  } catch (error) {
    metrics.failure = String(error);
    console.log(`LONG_HISTORY_INCOMPLETE ${JSON.stringify(metrics)}`);
    if (process.env.LONG_CONVERSATION_RESULT) await writeFile(process.env.LONG_CONVERSATION_RESULT, `${JSON.stringify(metrics, null, 2)}\n`);
    throw error;
  } finally {await context.close(); await browser.close(); await fixture.close();}
});

// The realistic backend returns only the newest 500 messages. Verify older
// pages are reached automatically while scrolling, without a user load-more
// control, and prepending a delayed page preserves the reader's existing anchor.
for (const width of [320, 1440]) test(`archive cursor pages join seamlessly without losing live messages or the reading anchor at ${width}px`, {skip: BASELINE}, async () => {
  const fixture = await createConsoleFixture();
  const browser = await chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
  const context = await browser.newContext({viewport: {width, height: width === 320 ? 844 : 1050}, ...(width === 320 ? {isMobile: true, hasTouch: true} : {})});
  const page = await context.newPage(), requests = [], errors = [];
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  let releaseOlder;
  const olderGate = new Promise(resolve => {releaseOlder = resolve;});
  let firstOlderRequested = false;
  try {
    const history = Array.from({length: MESSAGE_COUNT}, (_, index) => ({id: id(index), botId: BOT_A, role: index % 2 ? 'assistant' : 'user', text: markdown(index), createdAt: stamp(index)}));
    fixture.state.messages.set(BOT_A, history);
    await page.route(`**/v1/bots/${BOT_A}/messages**`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url()), before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER), limit = Number(url.searchParams.get('limit') || 500);
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 500);
      const all = fixture.state.messages.get(BOT_A), end = Math.min(all.length, before - 1), start = Math.max(0, end - limit);
      const snapshot = structuredClone({messages: all.slice(start, end), nextCursor: start > 0 ? String(start + 1) : null});
      requests.push({before: url.searchParams.get('before'), start, end});
      if (url.searchParams.has('before') && !firstOlderRequested) {firstOlderRequested = true; await olderGate;}
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(snapshot)});
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(fixture.url).origin});
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state: 'visible'});
    if (width === 320) await selectBot(page, BOT_A);
    await page.locator(selector(1199)).waitFor({state: 'attached'});
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
    await moveToHistory(page, 700);
    // At the top of the retained recent page, a normal upward scroll initiates
    // the archive request; eager background fetch is equally valid.
    await page.locator('#messages').evaluate(node => {node.dispatchEvent(new WheelEvent('wheel', {deltaY: -600, bubbles: true})); node.scrollTop = 0; node.dispatchEvent(new Event('scroll'));});
    await page.waitForFunction(() => document.querySelector('#messages')?.scrollTop === 0);
    for (let attempt = 0; !firstOlderRequested && attempt < 50; attempt++) await page.waitForTimeout(100);
    assert.equal(firstOlderRequested, true, 'older history loads from ordinary scrolling without a load-more action');
    await settle(page);
    const before = await anchor(page, 700);
    // The live stream is independent of the delayed archive response.
    const live = {id: 'archive-live-message', botId: BOT_A, role: 'assistant', text: 'Live answer received while an older archive page is in flight.', createdAt: stamp(1300)};
    fixture.state.messages.get(BOT_A).push(live);
    fixture.state.emit(BOT_A, 'message.created', {message: live});
    await page.locator('[data-message-id="archive-live-message"]').waitFor({state: 'attached'});
    await page.locator('#message').fill('Draft while the archive loads.');
    releaseOlder();
    await page.locator(selector(200)).waitFor({state: 'attached'});
    await settle(page);
    const after = await anchor(page, 700);
    assert.ok(Math.abs(after.top - before.top) <= 2, `prepending older page keeps the existing reading anchor (${before.top} -> ${after.top})`);
    assert.equal(await page.locator('[data-message-id="archive-live-message"]').count(), 1, 'older snapshot cannot drop or duplicate a live message');
    assert.equal(await page.locator('#message').inputValue(), 'Draft while the archive loads.');
    await moveToHistory(page, 200);
    await page.locator('#messages').evaluate(node => {node.scrollTop = 0; node.dispatchEvent(new Event('scroll'));});
    await page.locator(selector(0)).waitFor({state: 'attached'});
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), MESSAGE_COUNT, 'all archived messages are retained');
    assert.deepEqual(await page.locator('[data-message-id^="long-history-"]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), history.slice(0, MESSAGE_COUNT).map(message => message.id));
    assert.equal(await page.getByRole('button', {name: /load (?:more|older)|show older messages/i}).count(), 0);
    assert.ok(requests.some(request => request.before === '701') && requests.some(request => request.before === '201'), 'opaque rowid cursors are passed unchanged');
    await moveToHistory(page, 0);
    await page.locator(selector(0)).getByRole('button', {name: 'Copy message', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), markdown(0));
    assert.equal(await page.evaluate(() => window.find('unique-history-marker-0', false, false, true)), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'archive history does not overflow viewport');
    await selectBot(page, BOT_B);
    assert.equal(await page.locator('[data-message-id^="long-history-"]').count(), 0, 'archive is bot isolated');
    assert.equal(await page.locator('[data-message-id="archive-live-message"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.state.failures, []);
    console.log(`LONG_HISTORY_ARCHIVE ${JSON.stringify({width, requests})}`);
  } finally {releaseOlder(); await context.close(); await browser.close(); await fixture.close();}
});
