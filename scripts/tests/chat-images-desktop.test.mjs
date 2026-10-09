import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN} from './console-fixture.mjs';
const output=process.env.CONSOLE_SCREENSHOT_DIR||'/tmp/desktop-visual-chat';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=','base64');
for(const width of [1440,768])for(const colorScheme of ['dark','light'])test(`attachments ${width} ${colorScheme}`,async()=>{
 const fixture=await createConsoleFixture(),browser=await chromium.launch({headless:true,executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium'}),context=await browser.newContext({viewport:{width,height:1050},colorScheme}),page=await context.newPage();
 try{
 await mkdir(output,{recursive:true});await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#message').waitFor();
 const attach=page.getByRole('button',{name:'Attach images',exact:true}),send=page.getByRole('button',{name:'Send message',exact:true});
 for(const count of [0,1,4]){
 if(count)await page.locator('input[type=file]').setInputFiles(Array.from({length:count},(_,i)=>({name:`sample-${i+1}.png`,mimeType:'image/png',buffer:png})));
 await page.waitForFunction(n=>document.querySelectorAll('.timber-image-attachments img').length===n,count);
 await page.screenshot({path:`${output}/${width}-${colorScheme}-${count}.png`});
 const g=await page.evaluate(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {form:rect(document.querySelector('#message-form')),text:rect(document.querySelector('#message')),attach:rect(document.querySelector('[aria-label="Attach images"]')),send:rect(document.querySelector('[aria-label="Send message"]')),images:[...document.querySelectorAll('.timber-image-attachments img')].map(n=>({...rect(n),loaded:n.complete&&n.naturalWidth>0})),overflow:document.documentElement.scrollWidth>innerWidth};});
 await writeFile(`${output}/${width}-${colorScheme}-${count}.json`,JSON.stringify(g,null,2));
 assert.equal(g.overflow,false);assert.ok(Math.abs(g.attach.height-g.send.height)<=2,'equal control height');assert.ok(Math.abs(g.attach.y-g.send.y)<=2,'controls align');assert.ok(g.text.right<=g.attach.x+1,'text does not overlap controls');assert.ok(g.form.bottom<=1050);
 for(const image of g.images){assert.ok(image.loaded);assert.ok(image.bottom<=g.text.y+1,'thumbnails above row');assert.ok(image.x>=g.form.x&&image.right<=g.form.right);}
 assert.equal(await send.isEnabled(),count>0);assert.equal(await attach.isEnabled(),count<4);
 if(count){const remove=page.getByRole('button',{name:'Remove sample-1.png',exact:true});assert.equal(await remove.locator('svg').count(),1);await remove.focus();assert.equal(await remove.evaluate(n=>document.activeElement===n),true);const b=await remove.boundingBox();assert.ok(b.width>=24&&b.height>=24);await remove.press('Enter');assert.equal(await page.locator('.timber-image-attachments img').count(),count-1);while(await page.locator('.timber-image-attachments button').count())await page.locator('.timber-image-attachments button').first().click();}
 }
 }finally{await context.close();await browser.close();await fixture.close();}
});
