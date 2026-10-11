import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
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

const task = [
  'Contexto: conservar **toda la tarea** y leerla con claridad.',
  '',
  'Revisa los elementos exactos:',
  '- ruta: `apps/console/src/collaboration-timeline.tsx`',
  '- identificador: `task_id/v2`',
  '',
  '```js',
  'const ruta = "apps/console/src/collaboration-timeline.tsx";',
  'console.log("task_id/v2");',
  '```',
  '',
  '<script>window.__taskMarkdownExecuted = true</script>',
  '<img src=x onerror="window.__taskMarkdownExecuted = true">',
  '[ejecutar](javascript:window.__taskMarkdownExecuted=true)',
  '![capacidad](https://example.test/task.png)',
].join('\n');

for (const width of [320, 390, 1440]) test(`creation task Markdown stays safe and readable at ${width}px`, async () => {
  const fixture = await createConsoleFixture();
  const context = await browser.newContext({viewport: {width, height: 900}, colorScheme: 'dark', ...(width < 760 ? {isMobile: true, hasTouch: true} : {})});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const named = fixture.state.bots.find(bot => bot.id === BOT_B);
    named.instructions = task;
    named.createdByBotId = BOT_A;
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state: 'visible'});
    if (width < 760) await page.locator('.bot-item').first().click();
    await page.locator('#stream-state').filter({hasText: 'Live'}).waitFor({state: 'attached'});

    const card = page.locator(`[data-agent-created="${BOT_B}"]`);
    const header = card.getByRole('button', {name: 'Show Linus agent details', exact: true});
    await header.waitFor({state: 'visible'});
    assert.equal(await header.getAttribute('aria-expanded'), 'false');
    await header.focus();
    await page.keyboard.press('Enter');
    const expandedHeader = card.getByRole('button', {name: 'Hide Linus agent details', exact: true});
    await expandedHeader.waitFor();
    assert.equal(await expandedHeader.getAttribute('aria-expanded'), 'true');

    const markdown = card.locator('.timber-agent-created-task');
    await markdown.locator('p').filter({hasText: 'Contexto:'}).waitFor();
    await markdown.locator('ul > li').filter({hasText: 'ruta:'}).waitFor();
    await markdown.locator('li code').filter({hasText: 'apps/console/src/collaboration-timeline.tsx'}).waitFor();
    await markdown.locator('pre > code').filter({hasText: 'console.log("task_id/v2");'}).waitFor();
    const renderedText = await markdown.innerText();
    for (const exact of [
      'Contexto: conservar toda la tarea y leerla con claridad.',
      'ruta: apps/console/src/collaboration-timeline.tsx',
      'identificador: task_id/v2',
      'const ruta = "apps/console/src/collaboration-timeline.tsx";',
      'console.log("task_id/v2");',
    ]) assert.ok(renderedText.includes(exact), `rendered task preserves ${exact}`);
    assert.equal(await markdown.locator('script, img, iframe, object, embed, button').count(), 0, 'raw HTML, images and active controls are not created');
    assert.deepEqual(await markdown.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), [], 'javascript Markdown does not create a navigable link');
    assert.equal(await page.evaluate(() => window.__taskMarkdownExecuted), undefined, 'HTML/script and event handlers never execute');

    const dimensions = await page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth}));
    assert.ok(dimensions.scrollWidth <= dimensions.width, `page does not overflow viewport: ${JSON.stringify(dimensions)}`);
    const codeBox = await markdown.locator('pre').boundingBox();
    const detailsBox = await card.locator('.timber-agent-created-details').boundingBox();
    assert.ok(codeBox && detailsBox && codeBox.x >= detailsBox.x - 1 && codeBox.x + codeBox.width <= detailsBox.x + detailsBox.width + 1, 'code block stays within task card while its own contents may scroll');

    await expandedHeader.focus();
    await page.keyboard.press('Space');
    const collapsedHeader = card.getByRole('button', {name: 'Show Linus agent details', exact: true});
    await collapsedHeader.waitFor();
    assert.equal(await collapsedHeader.getAttribute('aria-expanded'), 'false');
    await collapsedHeader.getByText('Linus', {exact: true}).waitFor();
    await collapsedHeader.focus();
    await page.keyboard.press('Enter');
    await card.getByRole('button', {name: 'Open Linus conversation', exact: true}).click();
    await page.locator('#selected-name').filter({hasText: 'Linus'}).waitFor();
    assert.equal(new URL(page.url()).hash.includes(BOT_B), true, 'original conversation navigation still works');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(fixture.state.failures, [], 'fixture requests completed');
  } finally {await context.close(); await fixture.close();}
});
