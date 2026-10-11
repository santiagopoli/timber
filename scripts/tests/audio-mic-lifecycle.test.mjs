import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createConsoleBrowser} from './console-browser.mjs';
import {createConsoleFixture,BOT_A,BOT_B,TEST_TOKEN} from './console-fixture.mjs';

const consoleBrowser=createConsoleBrowser();
async function pageWithMic(initScript){
  const fixture=await createConsoleFixture(),browser=await consoleBrowser(),context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(initScript);const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.route('**/console/',async route=>{const response=await route.fetch(),headers={...response.headers()};headers['content-security-policy']=(headers['content-security-policy']||'').replace('img-src',"media-src 'self' blob:; img-src");await route.fulfill({response,headers});});
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#message').waitFor();
  await page.route(`**/v1/bots/${BOT_A}/audio/*`,route=>route.fulfill({status:201,contentType:'application/json',body:'{"audio":{}}'}));
  await page.route(`**/v1/bots/${BOT_A}/audio-messages`,route=>route.fulfill({status:202,contentType:'application/json',body:'{}'}));
  await page.route(`**/v1/bots/${BOT_B}/audio/*`,route=>route.fulfill({status:201,contentType:'application/json',body:'{"audio":{}}'}));
  return{fixture,context,page};
}
const deferredPermission=()=>{
  window.__micCalls=0;window.__trackStops=0;window.__recorderStarts=0;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>{window.__micCalls++;return new Promise(resolve=>{window.__resolveMic=()=>resolve({getTracks:()=>[{stop(){window.__trackStops++;}}]});});}}});
  window.MediaRecorder=class{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm;codecs=opus';constructor(){window.__recorder=this;}start(){window.__recorderStarts++;this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};
};
async function assertComposerLocked(page,phase){
  for(const selector of ['#message','button[aria-label="Add"]','button[aria-label="Send message"]'])assert.equal(await page.locator(selector).isDisabled(),true,`${selector} stays disabled while ${phase}`);
}
const immediatePermission=()=>{
  window.__micCalls=0;window.__trackStops=0;window.__recorderStarts=0;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micCalls++;return{getTracks:()=>[{stop(){window.__trackStops++;}}]};}}});
  window.MediaRecorder=class{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm;codecs=opus';constructor(){window.__recorder=this;}start(){window.__recorderStarts++;this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};
};
test('double-clicked deferred mic permission is requested once and late stream is stopped after conversation unmount',async()=>{
  const{fixture,context,page}=await pageWithMic(deferredPermission);
  try{
    const record=page.getByRole('button',{name:'Start recording audio'});await record.waitFor();await page.evaluate(()=>{const button=document.querySelector('[aria-label="Start recording audio"]');button.click();button.click();});await page.getByText('Requesting microphone permission…').waitFor();
    assert.equal(await page.evaluate(()=>window.__micCalls),1,'two synchronous DOM clicks cannot issue a second permission request');await assertComposerLocked(page,'microphone permission is pending');
    await page.locator(`#bot-list button[data-bot-id="${BOT_B}"]`).click();await page.waitForFunction(botId=>location.hash.includes(encodeURIComponent(botId)),BOT_B);
    await page.evaluate(()=>window.__resolveMic());await page.waitForFunction(()=>window.__trackStops===1);
    assert.deepEqual(await page.evaluate(()=>({micCalls:window.__micCalls,starts:window.__recorderStarts,stops:window.__trackStops})),{micCalls:1,starts:0,stops:1},'permission granted after unmount never starts a recorder and releases every acquired track');
    assert.equal(await page.locator('.timber-audio-draft').count(),0);
  }finally{await context.close();await fixture.close();}
});
test('MediaRecorder error stops capture and releases its microphone tracks',async()=>{
  const{fixture,context,page}=await pageWithMic(immediatePermission);
  try{
    await page.getByRole('button',{name:'Start recording audio'}).click({force:true});await page.getByRole('button',{name:'Stop recording'}).waitFor();await assertComposerLocked(page,'recording is active');
    await page.evaluate(()=>window.__recorder.onerror?.(new Event('error')));await page.waitForTimeout(200);const after=await page.evaluate(()=>({stops:window.__trackStops,state:window.__recorder?.state,error:document.querySelector('.timber-audio-error')?.innerText,recording:!!document.querySelector('[aria-label="Stop recording"]'),draft:!!document.querySelector('.timber-audio-draft')}));assert.ok(after.stops>=1);assert.equal(after.state,'inactive');assert.equal(after.recording,false);assert.equal(after.draft,false);assert.match(after.error,/could not finish this recording/);
    assert.deepEqual(await page.evaluate(()=>({calls:window.__micCalls,starts:window.__recorderStarts,state:window.__recorder.state})),{calls:1,starts:1,state:'inactive'});assert.ok(after.stops>=1,'all acquired microphone tracks are released on recorder error');assert.equal(after.recording,false);assert.equal(after.draft,false);assert.match(after.error,/could not finish this recording/);
  }finally{await context.close();await fixture.close();}
});

test('recording chunk over 20 MB stops capture, reports the limit, and releases tracks',async()=>{
  const oversizePermission=()=>{
    window.__micCalls=0;window.__trackStops=0;window.__recorderStarts=0;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micCalls++;return{getTracks:()=>[{stop(){window.__trackStops++;}}]};}}});
    window.MediaRecorder=class{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm;codecs=opus';constructor(){window.__recorder=this;}start(){window.__recorderStarts++;this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};
  };
  const{fixture,context,page}=await pageWithMic(oversizePermission);
  try{
    await page.getByRole('button',{name:'Start recording audio'}).click({force:true});await page.getByRole('button',{name:'Stop recording'}).waitFor();await assertComposerLocked(page,'recording is active');
    await page.evaluate(()=>window.__recorder.ondataavailable?.({data:{size:20_000_001}}));
    await page.locator('.timber-audio-error').filter({hasText:'20 MB limit'}).waitFor();await page.waitForFunction(()=>window.__trackStops>=1);
    assert.match(await page.locator('.timber-audio-error').innerText(),/20 MB limit/);assert.ok(await page.evaluate(()=>window.__trackStops>=1),'oversize audio releases the microphone track');assert.equal(await page.locator('.timber-audio-draft').count(),0,'oversize recording never becomes a draft');assert.equal(await page.getByRole('button',{name:'Stop recording'}).count(),0);
  }finally{await context.close();await fixture.close();}
});
