import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN} from './console-fixture.mjs';
test('desktop labels and composer icons are centered on desktop and mobile',async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  if(width===390)await page.locator('.bot-item').first().click();
  await page.locator('#message').fill('Check alignment');
  for(const selector of ['.timber-attach','.timber-send']){
   const result=await page.locator(selector).evaluate(button=>{const b=button.getBoundingClientRect(),s=button.querySelector('svg').getBoundingClientRect();return {x:Math.abs(b.x+b.width/2-s.x-s.width/2),y:Math.abs(b.y+b.height/2-s.y-s.height/2),text:button.textContent.trim()};});
   assert.ok(result.x<=1&&result.y<=1,`${selector} centered at ${width}: ${JSON.stringify(result)}`);assert.equal(result.text,'');
  }
  await page.locator('#panel-menu > summary').click();await page.locator('#tab-computer').click();
  for(const action of ['observe','control']){
   const result=await page.locator(`[data-desktop="${action}"]`).evaluate(button=>{const b=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);const t=range.getBoundingClientRect();return {x:Math.abs(b.x+b.width/2-t.x-t.width/2),y:Math.abs(b.y+b.height/2-t.y-t.height/2)};});
   assert.ok(result.x<=1&&result.y<=2,`${action} centered at ${width}: ${JSON.stringify(result)}`);
  }
  await page.close();
 }}finally{await browser.close();await fixture.close();}
});
