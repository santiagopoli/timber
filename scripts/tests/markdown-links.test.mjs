import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium, webkit} from 'playwright';
import {createConsoleFixture, TEST_TOKEN, BOT_A, BOT_B} from './console-fixture.mjs';

let browser;
before(async () => {
  const useWebkit = process.env.CONSOLE_BROWSER === 'webkit';
  browser = await (useWebkit ? webkit : chromium).launch({headless: true,
    ...(!useWebkit && process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(!useWebkit && process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
});
after(async () => {await browser?.close();});

async function withConversation(text, options, work, setup = () => {}) {
  const fixture = await createConsoleFixture();
  const context = await browser.newContext(options), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  setup(fixture.state);
  fixture.state.messages.set(BOT_A, [{id: 'markdown-links', botId: BOT_A, role: 'assistant', text: typeof text === 'function' ? text(fixture.state) : text, createdAt: new Date().toISOString()}]);
  try {
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state: 'visible'});
    if (options.viewport.width <= 760) await page.locator('.bot-item').first().click();
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});
    const message = page.locator('[data-message-id="markdown-links"]');
    await message.waitFor({state: 'visible'});
    await work({page, context, message, state: fixture.state, url: fixture.url});
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(fixture.state.failures, [], 'fixture requests completed');
  } finally {await context.close(); await fixture.close();}
}

function contrast(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const colorScheme of ['dark', 'light']) for (const width of [390, 1440]) {
  test(`message links stay readable and inline in ${colorScheme} at ${width}px`, async () => {
    const text = 'Abrí [Spacetime](https://example.test/app) desde Timber.\n\n[Ver documentación](https://example.test/docs) para continuar.';
    await withConversation(text, {viewport: {width, height: 900}, colorScheme}, async ({page, context, message}) => {
      const link = message.getByRole('link', {name: 'Spacetime', exact: true});
      await link.waitFor({state: 'visible'});
      const appearance = await link.evaluate(node => {
        const style = getComputedStyle(node);
        let background = 'rgba(0, 0, 0, 0)', parent = node.parentElement;
        while (parent && background === 'rgba(0, 0, 0, 0)') {background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement;}
        return {color: style.color, background, ownBackground: style.backgroundColor, display: style.display, padding: style.padding, decoration: style.textDecorationLine};
      });
      assert.equal(appearance.display, 'inline', 'a prose link is not a primary button');
      assert.equal(appearance.ownBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(appearance.padding, '0px');
      assert.match(appearance.decoration, /underline/, 'links are distinguishable without color');
      assert.ok(contrast(appearance.color, appearance.background) >= 4.5, `link contrast exceeds WCAG AA: ${JSON.stringify(appearance)}`);
      assert.equal(await message.locator('.timber-markdown button').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the message does not overflow the mobile viewport');
      await link.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await link.evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'keyboard focus is visible');
      if (process.env.CONSOLE_SCREENSHOT_DIR) {
        await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, {recursive: true});
        await page.screenshot({path: `${process.env.CONSOLE_SCREENSHOT_DIR}/markdown-links-${colorScheme}-${width}.png`, animations: 'disabled'});
      }
      await context.route('https://example.test/app', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Linked app</title><h1>App</h1>'}));
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.url(), 'https://example.test/app');
      assert.equal(await popup.evaluate(() => window.opener === null), true, 'the linked page cannot control the console');
      assert.equal(await popup.evaluate(() => document.referrer), '', 'external links do not receive conversation URLs');
      await popup.close();
    });
  });
}

test('message URL sanitization remains active for rendered and streaming links', async () => {
  const text = '[Safe](https://example.test/safe) [Script](javascript:alert%281%29) [Data](data:text/html,unsafe)\n\n[Obfuscated](jav&#x61;script:alert%281%29)\n\n<a href="javascript:alert(1)">raw HTML</a>';
  await withConversation(text, {viewport: {width: 390, height: 900}, colorScheme: 'dark'}, async ({page, message, state}) => {
    await message.getByRole('link', {name: 'Safe', exact: true}).waitFor();
    const destinations = await message.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    assert.deepEqual(destinations, ['https://example.test/safe'], 'dangerous URL schemes never become navigable links');
    const createdAt = new Date().toISOString();
    const run = {id: 'link-stream', botId: BOT_A, operationId: 'link-stream-operation', status: 'running', createdAt, updatedAt: createdAt};
    state.runs.set(BOT_A, [run]);
    state.emit(BOT_A, 'run.updated', {run}, run.id);
    state.emit(BOT_A, 'runtime.snapshot', {busy: true, partialText: 'See [Streaming docs](https://example.test/stream) [Bad](javascript:alert%281%29) [Pending link]('}, run.id);
    const stream = page.locator('#streaming-text');
    await stream.getByRole('link', {name: 'Streaming docs', exact: true}).waitFor();
    assert.deepEqual(await stream.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['https://example.test/stream']);
    assert.equal(await stream.locator('button').count(), 0);
    assert.match(await stream.innerText(), /Pending link/, 'an incomplete link keeps its text until the destination arrives');
    assert.equal(await stream.getByRole('link', {name: 'Pending link'}).count(), 0);
  });
});

function registerApp(state, botId = BOT_A) {
  const createdAt = new Date().toISOString();
  state.apps.set(botId, [{id: 'spacetime', botId, name: 'Spacetime', port: 3000, basePath: '/', url: state.appURL(botId, 'spacetime'), state: 'ready', createdAt, updatedAt: createdAt}]);
}

for (const width of [390, 1440]) test(`a registered app opens securely from its conversation link at ${width}px`, async () => {
  await withConversation(state => `[Spacetime](${state.appURL(BOT_A, 'spacetime').replace(/\/$/, '')})`, {viewport: {width, height: 900}, colorScheme: 'dark'}, async ({page, context, message, state, url}) => {
    const opened = context.waitForEvent('page');
    await message.getByRole('link', {name: 'Spacetime', exact: true}).click();
    const app = await opened;
    await app.getByRole('heading', {name: 'Workspace app is available'}).waitFor();
    assert.equal(app.url(), state.appURL(BOT_A, 'spacetime'), 'a root link without a trailing slash resolves to the registered app');
    assert.equal(await app.evaluate(() => window.opener), null);
    assert.equal(await page.locator('#panel-conversation').isVisible(), true, 'opening a link does not move the user away from the conversation');
    assert.deepEqual(state.calls.filter(call => call.path.endsWith('/open')).map(call => ({path: call.path, method: call.method})), [{path: `/v1/bots/${BOT_A}/apps/spacetime/open`, method: 'POST'}]);
    assert.equal(state.previewCalls[0].method, 'POST');
    assert.equal(state.previewCalls[0].origin, new URL(url).origin);
    assert.equal(new URLSearchParams(state.previewCalls[0].body).get('ticket'), 'fixture-ticket-spacetime');
    assert.equal(state.previewCalls.every(call => !call.authorization && !JSON.stringify(call).includes(TEST_TOKEN) && !call.url.includes('ticket')), true, 'only the one-time ticket in the POST body reaches the app origin');
    await app.close();
  }, state => registerApp(state));
});

test('a conversation cannot mint access for another bot or a lookalike app path', async () => {
  await withConversation(state => `[Other bot](${state.appURL(BOT_B, 'spacetime')}) [Lookalike](${state.appURL(BOT_A, 'spacetime').replace(/\/$/, '')}-other/)`, {viewport: {width: 390, height: 900}, colorScheme: 'dark'}, async ({context, message, state}) => {
    for (const name of ['Other bot', 'Lookalike']) {
      const opened = context.waitForEvent('page');
      await message.getByRole('link', {name, exact: true}).click();
      const app = await opened;
      await app.getByText('Open this app from Timber', {exact: true}).waitFor();
      await app.close();
    }
    assert.equal(state.calls.filter(call => call.path.endsWith('/open')).length, 0);
    assert.equal(state.previewCalls.length, 2);
    assert.equal(state.previewCalls.every(call => call.method === 'GET' && !call.authorization && !call.body), true, 'unregistered links receive no app ticket');
  }, state => {registerApp(state); registerApp(state, BOT_B);});
});

test('app launch errors stay visible in the conversation', async () => {
  await withConversation(state => `[Spacetime](${state.appURL(BOT_A, 'spacetime')})`, {viewport: {width: 390, height: 900}, colorScheme: 'dark'}, async ({page, message, state}) => {
    await page.evaluate(() => {window.open = () => null;});
    await message.getByRole('link', {name: 'Spacetime', exact: true}).click();
    await page.locator('#app-error').filter({hasText: 'Your browser blocked the new tab.'}).waitFor({state: 'visible'});
    assert.equal(await page.locator('#panel-conversation').isVisible(), true);
    assert.equal(state.calls.filter(call => call.path.endsWith('/open')).length, 0);
    assert.equal(state.previewCalls.length, 0);
  }, state => registerApp(state));
});
