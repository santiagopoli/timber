import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {createConsoleBrowser} from './console-browser.mjs';
import {createConsoleFixture,BOT_A,BOT_B,TEST_TOKEN} from './console-fixture.mjs';
const browserFor=createConsoleBrowser();
const {outputFiles}=await build({entryPoints:[new URL('../../packages/contracts/src/audio-validation.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {validateAudio}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
// Retired draft dictation is replaced by one voice-message flow. Capture uses
// real browser PCM from a synthetic tone, never a paid service or physical mic.
function pcmMic(){
 window.__micCalls=0;window.__trackStops=0;
 if(window.MediaRecorder)window.MediaRecorder.isTypeSupported=()=>false;
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
  window.__micCalls++;const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),out=ctx.createMediaStreamDestination();gain.gain.value=.2;osc.frequency.value=240;osc.connect(gain);gain.connect(out);osc.start();await ctx.resume();
  for(const track of out.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{window.__trackStops++;stop();osc.stop();void ctx.close();};}
  return out.stream;
 }}});
}
for(const width of [390,1280])test(`voice message ${width}: direct recording, immediate waveform during upload, automatic transcript and one canonical card`,async()=>{
 const fixture=await createConsoleFixture(),browser=await browserFor(),context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
 await context.addInitScript(pcmMic);const page=await context.newPage();page.setDefaultTimeout(6000);
 const calls={uploads:[],messages:[],dictations:[],downloads:[]};let release;const gate=new Promise(resolve=>{release=resolve;});let saved;
 await page.route('**/v1/bots/*/dictations**',route=>{calls.dictations.push(route.request().url());return route.abort();});
 await page.route(`**/v1/bots/${BOT_A}/audio/*`,async route=>{if(route.request().method()!=='PUT')return route.fallback();const bytes=await route.request().postDataBuffer();calls.uploads.push({bytes,type:route.request().headers()['content-type']});await gate;await route.fulfill({status:201,contentType:'application/json',body:'{"audio":{}}'});});
 await page.route(`**/v1/bots/${BOT_A}/audio-messages/**`,route=>route.fulfill({status:saved?200:404,contentType:'application/json',body:JSON.stringify(saved?{message:saved}:{})}));
 await page.route(`**/v1/bots/${BOT_A}/audio-messages`,async route=>{
  const input=route.request().postDataJSON();calls.messages.push(input);const source=calls.uploads[0],checked=validateAudio(new Uint8Array(source.bytes),source.type);
  saved={id:'canonical-voice',botId:BOT_A,role:'user',text:'',createdAt:new Date().toISOString(),audio:{artifactId:input.audioId,mimeType:checked.mimeType,size:source.bytes.length,durationMs:checked.durationMs,operationId:input.operationId,transcription:{attemptId:input.attemptId,status:'succeeded',text:'The recorded voice message.'}}};
  await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({message:saved})});
 });
 await page.route(`**/v1/bots/${BOT_A}/artifacts/*`,route=>{calls.downloads.push(route.request().url());return route.abort();});
 try{
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#message').waitFor();await page.setViewportSize({width,height:844});
  assert.equal(await page.getByRole('button',{name:'Dictate text',exact:true}).count(),0);
  await page.getByRole('button',{name:'Add',exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'Record audio',exact:true}).count(),0);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Record audio',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();await page.waitForTimeout(700);await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.locator('.timber-audio-draft').waitFor();assert.equal(await page.evaluate(()=>window.__micCalls),1);assert.equal(await page.evaluate(()=>window.__trackStops),1);assert.equal(calls.uploads.length,0,'Stop keeps the preview local until Send');
  await page.getByRole('button',{name:'Send audio',exact:true}).click();
  const card=page.locator('.timber-audio-message');await card.getByText('Sending audio…',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.timber-audio-message .timber-audio-player')?.dataset.waveform==='decoded');
  await page.waitForFunction(()=>document.querySelector('.timber-audio-message audio')?.readyState>=2);assert.equal(await card.locator('.timber-audio-error').count(),0,'the original plays under the production media CSP');assert.equal(await card.getByRole('button',{name:'Play audio'}).isEnabled(),true);assert.equal(await page.getByRole('dialog').count(),0);assert.equal(calls.messages.length,0,'the waveform is already visible while the upload is held');assert.equal(calls.downloads.length,0);
  release();await page.locator('[data-message-id="canonical-voice"]').waitFor();assert.equal(await card.count(),1,'the canonical receipt replaces the optimistic card');assert.equal(calls.messages.length,1);assert.equal(calls.dictations.length,0);
  await card.getByRole('button',{name:'Show transcript'}).click();await card.getByText('The recorded voice message.',{exact:true}).waitFor();assert.equal(calls.downloads.length,0,'the canonical card keeps its validated local original');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
  if(width===390){await page.screenshot({path:'/tmp/timber-unified-audio-mobile.png'});await page.locator(`#bot-list button[data-bot-id="${BOT_B}"]`).evaluate(button=>button.click());await page.waitForFunction(id=>location.hash.includes(encodeURIComponent(id)),BOT_B);assert.equal(await page.locator('[data-message-id="canonical-voice"]').count(),0,'local previews stay in their conversation');}
 }finally{release();await context.close();await fixture.close();}
});
