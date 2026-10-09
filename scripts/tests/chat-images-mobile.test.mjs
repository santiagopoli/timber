import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN} from './console-fixture.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = n => ({name:`mobile-${n}.png`,mimeType:'image/png',buffer:png});
const output=process.env.MOBILE_VISUAL_OUTPUT || '/tmp/mobile-visual-captures';
for(const width of [390,320]) test(`mobile image composer geometry and accessible controls at ${width}px`,async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});
 const context=await browser.newContext({viewport:{width,height:844},colorScheme:'light'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);await mkdir(output,{recursive:true});
 const capture=name=>page.screenshot({path:`${output}/${width}-${name}.png`});
 const geometry=async count=>{
  const form=page.locator('#message-form'),textarea=await page.locator('#message').boundingBox();
  const attach=await form.getByRole('button',{name:'Attach images',exact:true}).boundingBox(),send=await form.getByRole('button',{name:'Send message',exact:true}).boundingBox();
  assert.ok(textarea.width>=width-160,'attachments do not squeeze text field');
  for(const [name,box] of [['attach',attach],['send',send]]){
   assert.ok(box&&box.width>=44&&box.height>=44,`${name} mobile touch target`);
   assert.ok(box.x>=0&&box.x+box.width<=width&&box.y+box.height<=844,`${name} within viewport`);
  }
  assert.ok(Math.abs(attach.width-send.width)<=2&&Math.abs(attach.height-send.height)<=2,'matched attach/send icon controls');
  assert.equal(await page.locator('.timber-image-attachments img').count(),count);
  const thumbs=await page.locator('.timber-image-attachments img').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
  for(const r of thumbs){assert.ok(r.width<=88&&r.height<=88&&r.width>=48,'compact bounded thumbnails');assert.ok(r.y+r.height<=textarea.y+1,'previews separate from typing row');}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page overflow');
  if(count){const strip=await page.locator('.timber-image-attachments').boundingBox();assert.ok(strip.x>=0&&strip.x+strip.width<=width,'scrolling strip stays in viewport');const last=page.locator('.timber-image-attachments img').last();await last.scrollIntoViewIfNeeded();const r=await last.boundingBox();assert.ok(r.x>=0&&r.x+r.width<=width,'last preview reachable by scrolling');await page.locator('.timber-image-attachments').evaluate(el=>el.scrollLeft=0);}
  const size=await form.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));assert.ok(size.scroll<=size.client+1,'no composer overflow');
 };
 try{
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('.bot-item').first().click();await page.locator('#message').waitFor({state:'visible'});
  assert.equal(await page.locator('#message').getAttribute('placeholder'),'Message Ada','short placeholder omits mention instructions');
  await capture('empty');await geometry(0);assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach images',exact:true}).click();await(await chooser).setFiles(image(1));await page.locator('.timber-image-attachments img').waitFor();
  await capture('one');await geometry(1);assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true,'image-only input can send');
  await page.locator('input[type=file]').setInputFiles([image(2),image(3),image(4)]);await page.waitForFunction(()=>document.querySelectorAll('.timber-image-attachments img').length===4);
  await capture('four');await geometry(4);
  await page.locator('#message').fill(('A long line of mobile composer text. '.repeat(12)+'\n').repeat(3));await capture('long-text');await geometry(4);assert.ok((await page.locator('#message').boundingBox()).height<=161,'long text height bounded');
  await page.locator('input[type=file]').setInputFiles(image(5));await page.locator('.timber-attachment-error[role=alert]').waitFor({state:'visible'});await capture('error');await geometry(4);
  const alert=await page.locator('.timber-attachment-error').boundingBox();assert.ok(alert.x>=0&&alert.x+alert.width<=width&&alert.y+alert.height<=844,'error readable within viewport');
  await page.getByRole('button',{name:/^Remove mobile-/}).first().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.timber-image-attachments img').length===3);await geometry(3);
  assert.deepEqual(errors,[],'no browser errors');assert.deepEqual(fixture.state.failures,[],'fixture requests complete');
 }finally{await context.close();await browser.close();await fixture.close();}
});
