import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
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

async function selectBot(page, id) {
  const item = page.locator(`[data-bot-id="${id}"]`);
  if (!await item.isVisible()) await page.locator('#mobile-back').click();
  await item.click();
  await page.locator('#selected-name').filter({hasText: id === BOT_A ? 'Ada' : 'Linus'}).waitFor();
}
async function openPanel(page, name) {
  if (!await page.locator(`#tab-${name}`).isVisible()) await page.locator('#panel-menu > summary').click();
  await page.locator(`#tab-${name}`).click();
}
async function collapsed(page, count = 8) {
  const toggle = page.locator('[data-chat-agents-toggle]');
  await toggle.locator('span').filter({hasText: `Agents ${count}`}).waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.evaluate(node => node.closest('.bot-header') !== null), true, 'disclosure is in the existing static header');
  assert.equal(await page.locator('#chat-root [data-chat-agents-toggle]').count(), 0, 'no separate collapsed toolbar');
  assert.equal(await page.locator('.timber-chat-agents button').count(), 0, 'no hidden agent cards are rendered when collapsed');
  assert.equal(await page.locator('.timber-chat-agents').evaluate(node => node.getBoundingClientRect().height), 0, 'collapsed agents consume zero conversation rows');
  const id = await toggle.getAttribute('aria-controls');
  assert.ok(id);
  assert.equal(await page.locator('.timber-chat-agents').getAttribute('id'), id, 'aria-controls resolves to the expanded list');
  assert.equal(await page.locator('.timber-chat-agents').getAttribute('aria-label'), 'Agent collaboration');
}

for (const width of [320, 390, 1440]) test(`Agents disclosure uses the existing header and reveals only active collaborators at ${width}px`, async () => {
  const fixture = await createConsoleFixture();
  const context = await browser.newContext({viewport: {width, height: width === 1440 ? 1050 : 844}, colorScheme: 'light', ...(width < 760 ? {isMobile: true, hasTouch: true} : {})});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    const stamp = new Date().toISOString();
    const statuses = ['running', 'waiting_approval', 'waiting_connection', 'queued', 'completed', 'failed', 'cancelled', 'interrupted'];
    // Even an old running record stays active until the backend supplies a terminal status.
    const agents = statuses.map((status, index) => ({
      id: `header-agent-${index}`, name: index === 0 ? 'Architecture reviewer with an exceptionally long collaborator name that must not push header controls away' : `Reviewer ${index + 1}`,
      task: 'Review the project', parentOperationId: 'header-parent-operation', operationId: `header-child-operation-${index}`, status, createdAt: index === 0 ? '2020-01-01T00:00:00.000Z' : stamp, updatedAt: index === 0 ? '2020-01-01T00:00:00.000Z' : stamp,
    }));
    fixture.state.agents.set(BOT_A, agents);
    const delegations = statuses.map((status, index) => ({id: `header-delegation-${index}`, sourceBotId: BOT_A, sourceBotName: 'Ada', sourceRunId: 'header-parent-run', targetBotId: BOT_B,
      targetBotName: 'Linus with a very long delegated collaborator display name that must be ellipsized', path: [BOT_A, BOT_B], status, createdAt: stamp, updatedAt: stamp}));
    fixture.state.delegations.set(BOT_A, delegations);
    fixture.state.runs.set(BOT_A, [{id: 'header-parent-run', botId: BOT_A, operationId: 'header-parent-operation', status: 'running', createdAt: stamp, updatedAt: stamp}]);
    fixture.state.bots.find(bot => bot.id === BOT_A).name = 'Ada with a very long conversation name that must leave room for Agents';
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state: 'visible'});
    if (width < 760) await page.locator(`[data-bot-id="${BOT_A}"]`).click();
    await page.locator('#bot-workspace').waitFor({state: 'visible'});
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
    await collapsed(page);
    const headerBefore = await page.locator('.bot-header').boundingBox();
    const conversationBefore = await page.locator('.timber-conversation').boundingBox();
    const toggle = page.locator('[data-chat-agents-toggle]');
    assert.equal(await toggle.innerText(), 'Agents 8', 'only the four active temporary and four active delegated collaborators count');
    assert.equal(await page.locator('#agent-count').textContent(), '8', 'management badge matches the active header count');
    const headerGeometry = await page.locator('.bot-header').evaluate(node => {
      const names = ['#selected-name', '[data-chat-agents-toggle]', '#mobile-back', '#cancel-run', '#more-panels', '#run-status', '#toggle-workspace'];
      return names.map(selector => {const element = node.querySelector(selector), rect = element.getBoundingClientRect(); return {selector, x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0};});
    });
    for (const rect of headerGeometry.filter(rect => rect.visible)) {
      assert.ok(rect.x >= 0 && rect.right <= width + 1, `${rect.selector} fits the ${width}px header`);
      assert.ok(rect.y >= headerBefore.y && rect.bottom <= headerBefore.y + headerBefore.height + 1, 'all controls stay in the same header row');
    }
    const toggleBox = await toggle.boundingBox();
    assert.ok(toggleBox.height >= 44, 'Agents toggle has a 44px touch target');
    const nameGeometry = await page.locator('#selected-name').evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth, ellipsis: getComputedStyle(node).textOverflow}));
    if (width < 760) {assert.ok(nameGeometry.width > 0 && nameGeometry.scroll > nameGeometry.width); assert.equal(nameGeometry.ellipsis, 'ellipsis');}
    assert.equal(await page.locator('#cancel-run').isVisible(), true, 'existing stop control remains available');

    await toggle.click();
    const list = page.locator('.timber-chat-agents');
    await list.waitFor({state: 'visible'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await list.locator('.timber-chat-agent-list > button').count(), 8, 'terminal collaborators are absent from the header list');
    assert.deepEqual(await list.locator('[data-chat-agent]').evaluateAll(nodes => nodes.map(node => node.dataset.chatAgent)), agents.slice(0, 4).map(agent => agent.id));
    assert.deepEqual(await list.locator('[data-chat-delegation]').evaluateAll(nodes => nodes.map(node => node.dataset.chatDelegation)), delegations.slice(0, 4).map(delegation => delegation.id));
    for (const agent of agents.slice(0, 4)) {
      assert.equal(await list.locator(`[data-chat-agent="${agent.id}"] .status`).getAttribute('data-status'), agent.status);
      assert.equal(await list.locator(`[data-chat-agent="${agent.id}"] .status`).innerText(), agent.status.replaceAll('_', ' '));
    }
    for (const delegation of delegations.slice(0, 4)) {
      assert.equal(await list.locator(`[data-chat-delegation="${delegation.id}"] .status`).getAttribute('data-status'), delegation.status);
    }
    const listGeometry = await list.evaluate(node => ({height: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY, width: node.getBoundingClientRect().width}));
    assert.ok(listGeometry.height <= 241 && listGeometry.height <= 844 * 0.35 + 1, 'expanded list is vertically bounded');
    assert.equal(listGeometry.overflow, 'auto');
    if (width < 760) assert.ok(listGeometry.scroll > listGeometry.height, 'active agents remain scroll-accessible on mobile');
    assert.ok(listGeometry.width <= width, 'list does not overflow the viewport');
    const cards = await list.locator('.timber-chat-agent-list > button').evaluateAll(nodes => nodes.map(node => {
      const name = node.querySelector('.timber-chat-agent-name'), status = node.querySelector('.status'), rect = node.getBoundingClientRect();
      return {height: rect.height, left: rect.left, right: rect.right, nameRight: name.getBoundingClientRect().right, statusLeft: status.getBoundingClientRect().left, ellipsis: getComputedStyle(name).textOverflow};
    }));
    for (const card of cards) {assert.ok(card.height >= 44); assert.ok(card.left >= 0 && card.right <= width + 1); assert.ok(card.nameRight <= card.statusLeft, 'long names do not overlap status'); assert.equal(card.ellipsis, 'ellipsis');}
    assert.equal(await list.getByRole('button', {name: 'View all agents'}).count(), 1);
    assert.equal((await page.locator('.bot-header').boundingBox()).height, headerBefore.height, 'expansion does not add a header row');

    // Live completion removes only that collaborator and preserves the open disclosure.
    agents[0] = {...agents[0], status: 'completed', updatedAt: new Date(Date.now() + 1000).toISOString()};
    fixture.state.agents.set(BOT_A, agents);
    fixture.state.emit(BOT_A, 'subagent.updated', {subagent: agents[0]});
    await list.locator('[data-chat-agent="header-agent-0"]').waitFor({state: 'detached'});
    await toggle.locator('span').filter({hasText: 'Agents 7'}).waitFor();
    assert.equal(await page.locator('#agent-count').textContent(), '7');
    assert.equal(await list.locator('.timber-chat-agent-list > button').count(), 7);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await list.locator('[data-chat-agent="header-agent-1"]').focus();
    await page.keyboard.press('Escape');
    await collapsed(page, 7);
    assert.equal(await toggle.evaluate(node => document.activeElement === node), true, 'Escape returns focus to the header toggle');
    const conversationAfter = await page.locator('.timber-conversation').boundingBox();
    assert.equal(conversationAfter.y, conversationBefore.y, 'collapsing restores the entire conversation line');
    assert.equal(conversationAfter.height, conversationBefore.height);
    await toggle.click(); await toggle.press('Escape'); await collapsed(page, 7);

    await toggle.click();
    await list.locator('[data-chat-agent="header-agent-1"]').click();
    await page.locator('[data-agent-detail="header-agent-1"]').waitFor();
    assert.ok(new URL(page.url()).hash.includes('agent=header-agent-1'), 'agent card opens the actual management conversation');
    assert.equal(await page.locator('#chat-agents-header').evaluate(node => node.hidden), await page.locator('#panel-conversation').evaluate(node => node.hidden), 'header host follows conversation visibility');
    if (width === 1440) {await page.locator('#expand-workspace').click(); await page.locator('#chat-agents-header').waitFor({state: 'hidden'});}
    else assert.equal(await toggle.isVisible(), false, 'no orphan toggle while mobile agent panel replaces chat');
    await openPanel(page, 'conversation');
    await toggle.waitFor({state: 'visible'});
    // Management navigation remains available separately from selecting a child.
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await list.getByRole('button', {name: 'View all agents'}).click();
    await page.locator('[data-agent-id="header-agent-0"]').waitFor();
    assert.equal(await page.locator('[data-agent-detail]').count(), 0, 'management opens the all-agents view');
    assert.equal(await page.locator('[data-agent-id]').count(), agents.length, 'View all includes archived temporary agents');
    assert.equal(await page.locator('[data-delegation-id]').count(), delegations.length, 'View all includes archived delegations');
    await openPanel(page, 'conversation');
    // Switch bots while expanded: keyed Chat state must not leak the disclosure.
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await selectBot(page, BOT_B);
    await toggle.waitFor({state: 'detached'});
    assert.equal(await page.locator('#chat-agents-header').isVisible(), false, 'empty bot has no Agents control or reserved width');
    assert.equal(await page.locator('.timber-chat-agents').count(), 0);
    await selectBot(page, BOT_A);
    await collapsed(page, 7);
    // Complete the remaining active work: hide the control, not archival management.
    await toggle.click();
    for (let index = 1; index < 4; index++) {
      agents[index] = {...agents[index], status: 'completed', updatedAt: new Date(Date.now() + 2000).toISOString()};
      fixture.state.emit(BOT_A, 'subagent.updated', {subagent: agents[index]});
    }
    for (let index = 0; index < 4; index++) {
      delegations[index] = {...delegations[index], status: 'completed', updatedAt: new Date(Date.now() + 2000).toISOString()};
      fixture.state.emit(BOT_A, 'delegation.updated', {delegation: delegations[index]});
    }
    fixture.state.agents.set(BOT_A, agents);
    fixture.state.delegations.set(BOT_A, delegations);
    await toggle.waitFor({state: 'detached'});
    assert.equal(await page.locator('#agent-count').textContent(), '0');
    assert.equal(await page.locator('#chat-agents-header').isVisible(), false, 'zero active agents reserve no header width');
    assert.equal(await page.locator('.timber-chat-agents').count(), 0);
    await page.reload();
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
    assert.equal(await toggle.count(), 0, 'terminal records remain excluded after reload');
    assert.equal(await page.locator('#agent-count').textContent(), '0');
    await openPanel(page, 'agents');
    await page.locator('[data-agent-id="header-agent-0"]').waitFor();
    assert.equal(await page.locator('[data-agent-id]').count(), agents.length, 'Agents menu still opens the complete archive at zero active');
    assert.equal(await page.locator('[data-delegation-id]').count(), delegations.length);
    await page.locator('[data-agent-id="header-agent-0"]').click();
    await page.locator('[data-agent-detail="header-agent-0"]').waitFor();
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(fixture.state.failures, [], 'fixture requests succeeded');
  } finally {await context.close(); await fixture.close();}
});
