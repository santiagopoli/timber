import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN} from './console-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
});
after(async () => {await browser?.close();});

for (const width of [320, 390, 1024, 1440]) test(`bot list shares its left alignment axis at ${width}px`, async () => {
  const fixture = await createConsoleFixture();
  const context = await browser.newContext({viewport: {width, height: width < 700 ? 844 : 900}, ...(width < 700 ? {isMobile: true, hasTouch: true} : {})});
  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state: 'visible'});
    if (!await page.locator('#bot-search').isVisible()) await page.locator('#toggle-bots').click();
    await page.locator('#bot-search').waitFor({state: 'visible'});
    const geometry = await page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {left: rect.left, right: rect.right, width: rect.width};
      };
      return {
        title: box('.sidebar-heading h2'),
        search: box('.search-field'),
        row: box('.bot-item'),
        avatar: box('.bot-item .avatar'),
      };
    });
    for (const [name, box] of Object.entries(geometry)) assert.ok(box.width > 0, `${name} is rendered`);
    assert.ok(Math.abs(geometry.title.left - geometry.search.left) <= 1, 'Bots title and search begin on the same axis');
    assert.ok(Math.abs(geometry.title.left - geometry.avatar.left) <= 1, `bot avatar begins on the title/search axis: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.title.left - geometry.row.left) <= 1, 'bot row begins on the same content axis');
  } finally {
    await context.close();
    await fixture.close();
  }
});
