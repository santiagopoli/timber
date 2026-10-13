import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createConsoleBrowser} from './console-browser.mjs';
import {createConsoleFixture,BOT_A,BOT_B,TEST_TOKEN} from './console-fixture.mjs';

const consoleBrowser=createConsoleBrowser();
async function pageWithMic(initScript,{activeRun}={}){
  const fixture=await createConsoleFixture(),browser=await consoleBrowser(),context=await browser.newContext({viewport:{width:1280,height:900}});
  if(activeRun)fixture.state.runs.get(BOT_A).push(activeRun);
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

const mp4OnlyPermission=()=>{
  window.__micCalls=0;window.__trackStops=0;window.__recorderStarts=0;window.__contextCloses=0;window.__connections=[];
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micCalls++;return{getTracks:()=>[{stop(){window.__trackStops++;}}]};}}});
  window.MediaRecorder=class{static isTypeSupported=type=>type==='audio/mp4';constructor(){window.__recorderStarts++;throw new Error('MP4 must not be recorded or relabelled');}};
  const node=()=>({connect(target){window.__connections.push(target);},disconnect(){this.disconnected=true;}});
  window.AudioContext=class{
    state='running';sampleRate=48000;destination={};
    resume(){return Promise.resolve();}close(){this.state='closed';window.__contextCloses++;return Promise.resolve();}
    createMediaStreamSource(){return window.__pcmSource=node();}
    createGain(){return window.__pcmGain={...node(),gain:{value:1}};}
    createScriptProcessor(size,input,output){window.__processorShape={size,input,output};return window.__pcmProcessor={...node(),onaudioprocess:null};}
  };
  const NativeFile=window.File;window.File=class extends NativeFile{constructor(...args){super(...args);if(String(args[1]).startsWith('Recording-'))window.__pcmFile=this;}};
};
async function beginPcm(page){await page.getByRole('button',{name:'Start recording audio'}).click();await page.getByRole('button',{name:'Stop recording'}).waitFor();}
async function feedPcm(page,count=1){await page.evaluate(count=>{const data=Float32Array.from({length:4096},(_,i)=>Math.sin(i/8)*0.5);for(let i=0;i<count;i++)window.__pcmProcessor.onaudioprocess?.({inputBuffer:{getChannelData:()=>data}});},count);}

test('MP4-only capability uses bounded mono PCM16 WAV, never MP4 MediaRecorder or automatic send',async()=>{
  const{fixture,context,page}=await pageWithMic(mp4OnlyPermission);
  try{
    await beginPcm(page);await assertComposerLocked(page,'PCM capture is active');await feedPcm(page,12);
    assert.equal(await page.evaluate(()=>window.__recorderStarts),0,'no MP4 recorder is constructed');
    assert.deepEqual(await page.evaluate(()=>window.__processorShape),{size:4096,input:1,output:1});
    assert.equal(await page.evaluate(()=>window.__pcmGain.gain.value),0,'capture output is silenced, not microphone monitoring');
    await page.getByRole('button',{name:'Stop recording'}).click();await page.locator('.timber-audio-draft').waitFor();
    const actual=await page.evaluate(async()=>{const f=window.__pcmFile,b=await f.arrayBuffer(),v=new DataView(b);return{type:f.type,size:f.size,name:f.name,riff:String.fromCharCode(...new Uint8Array(b,0,4)),channels:v.getUint16(22,true),rate:v.getUint32(24,true),bits:v.getUint16(34,true),data:v.getUint32(40,true),first:v.getInt16(44,true),next:v.getInt16(46,true),stops:window.__trackStops,closed:window.__contextCloses,disconnected:window.__pcmProcessor.disconnected};});
    assert.equal(actual.type,'audio/wav');assert.match(actual.name,/\.wav$/);assert.equal(actual.riff,'RIFF');assert.equal(actual.channels,1);assert.equal(actual.rate,16000);assert.equal(actual.bits,16);assert.equal(actual.size,44+12*4096/3*2);assert.equal(actual.data,actual.size-44);assert.notEqual(actual.next,actual.first,'PCM contains signal, not a fabricated silent placeholder');assert.equal(actual.stops,1);assert.equal(actual.closed,1);assert.equal(actual.disconnected,true);
    assert.equal(fixture.state.calls.filter(call=>/\/audio(?:-messages)?\//.test(call.path)).length,0,'stop produces only a local reviewable draft');
    await page.getByRole('button',{name:'Cancel audio'}).click();assert.equal(await page.locator('.timber-audio-draft').count(),0);
  }finally{await context.close();await fixture.close();}
});

test('PCM sample count stops at ten minutes without exceeding the 20 MB bound',async()=>{
  const{fixture,context,page}=await pageWithMic(mp4OnlyPermission);
  try{
    await beginPcm(page);await feedPcm(page,7032);await page.locator('.timber-audio-draft').waitFor();
    const info=await page.evaluate(async()=>{const file=window.__pcmFile,v=new DataView(await file.arrayBuffer());return{size:file.size,rate:v.getUint32(24,true),frames:v.getUint32(40,true)/2,closed:window.__contextCloses,stops:window.__trackStops};});
    assert.equal(info.frames,info.rate*600);assert.equal(info.size,19_200_044);assert.ok(info.size<=20_000_000);assert.equal(info.closed,1);assert.equal(info.stops,1);assert.match(await page.locator('.timber-audio-draft').innerText(),/10:00/);
  }finally{await context.close();await fixture.close();}
});

for(const event of ['visibilitychange','pagehide','hashchange'])test(`${event} discards active PCM capture and closes every resource`,async()=>{
  const{fixture,context,page}=await pageWithMic(mp4OnlyPermission);
  try{
    await beginPcm(page);await feedPcm(page);
    await page.evaluate(event=>{if(event==='visibilitychange')Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});(event==='visibilitychange'?document:window).dispatchEvent(new Event(event));},event);
    await page.waitForFunction(()=>window.__trackStops===1&&window.__contextCloses===1);
    assert.equal(await page.getByRole('button',{name:'Stop recording'}).count(),0);assert.equal(await page.locator('.timber-audio-draft').count(),0,'background/navigation interruptions never publish a review draft');
    assert.ok(await page.evaluate(()=>window.__pcmProcessor.disconnected&&window.__pcmSource.disconnected&&window.__pcmGain.disconnected));
    assert.equal(await page.evaluate(()=>window.__pcmProcessor.onaudioprocess),null);
  }finally{await context.close();await fixture.close();}
});

test('hidden deferred permission is fenced and a fresh recording cannot consume its late stream',async()=>{
  const{fixture,context,page}=await pageWithMic(deferredPermission);
  try{
    await page.getByRole('button',{name:'Start recording audio'}).click();await page.getByText('Requesting microphone permission…').waitFor();
    await page.evaluate(()=>{window.__oldResolve=window.__resolveMic;Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByRole('button',{name:'Start recording audio'}).click();await page.getByText('Requesting microphone permission…').waitFor();
    await page.evaluate(()=>window.__oldResolve());await page.waitForFunction(()=>window.__trackStops===1);
    assert.equal(await page.evaluate(()=>window.__recorderStarts),0);await assertComposerLocked(page,'the newer permission request remains pending');
    await page.evaluate(()=>window.__resolveMic());await page.getByRole('button',{name:'Stop recording'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__recorderStarts),1);await page.getByRole('button',{name:'Discard'}).click();assert.equal(await page.evaluate(()=>window.__trackStops),2);
  }finally{await context.close();await fixture.close();}
});

test('logout click cancels PCM before the session deletion settles',async()=>{
  const{fixture,context,page}=await pageWithMic(mp4OnlyPermission);let release;const gate=new Promise(resolve=>{release=resolve;});
  try{
    await beginPcm(page);await feedPcm(page);await page.route('**/v1/session',async route=>{if(route.request().method()!=='DELETE')return route.continue();await gate;await route.fulfill({status:200,contentType:'application/json',body:'{"authenticated":false}'});});
    // Invoke the real control even when the Settings sheet is closed.
    await page.locator('#disconnect').evaluate(button=>button.click());
    await page.waitForFunction(()=>window.__trackStops===1&&window.__contextCloses===1);assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(await page.getByRole('button',{name:'Stop recording'}).count(),0);
    release();await page.locator('#login').waitFor();
  }finally{release();await context.close();await fixture.close();}
});

test('visibility loss also cancels preferred WebM capture without a background draft',async()=>{
  const{fixture,context,page}=await pageWithMic(immediatePermission);
  try{
    await page.getByRole('button',{name:'Start recording audio'}).click();await page.getByRole('button',{name:'Stop recording'}).waitFor();
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.evaluate(()=>window.__trackStops),1);assert.equal(await page.evaluate(()=>window.__recorder.state),'inactive');assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(await page.getByRole('button',{name:'Stop recording'}).count(),0);
  }finally{await context.close();await fixture.close();}
});


for(const phase of ['recording','pending permission'])test(`actual Stop run control discards ${phase} before cancellation settles without any audio admission`,async()=>{
  const activeRun={id:'10000000-0000-4000-8000-000000000072',botId:BOT_A,operationId:'10000000-0000-4000-8000-000000000073',model:'gpt-6.1-sol',status:'running',createdAt:'2026-10-05T10:00:00.000Z',updatedAt:'2026-10-05T10:00:00.000Z'};
  const{fixture,context,page}=await pageWithMic(phase==='recording'?immediatePermission:deferredPermission,{activeRun});let release;
  const gate=new Promise(resolve=>{release=resolve;}),audioRequests=[];
  page.on('request',request=>{if(/\/v1\/bots\/[^/]+\/audio(?:-messages)?(?:\/|$)/.test(new URL(request.url()).pathname))audioRequests.push({method:request.method(),path:new URL(request.url()).pathname});});
  try{
    const stopRun=page.locator('#cancel-run');await stopRun.waitFor();assert.equal(await stopRun.isEnabled(),true,'a real active fixture run enables the production Stop control');
    await page.route(`**/v1/bots/${BOT_A}/runs/${activeRun.id}/cancel`,async route=>{await gate;await route.continue();});
    await page.getByRole('button',{name:'Start recording audio'}).click();
    if(phase==='recording')await page.getByRole('button',{name:'Stop recording'}).waitFor();else await page.getByText('Requesting microphone permission…').waitFor();
    await assertComposerLocked(page,phase);
    const cancelRequested=page.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith(`/runs/${activeRun.id}/cancel`));
    const cancelled=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/runs/${activeRun.id}/cancel`));
    await stopRun.click();await cancelRequested;
    assert.equal(fixture.state.runs.get(BOT_A)[0].status,'running','cancellation response remains gated while microphone interruption takes effect');
    if(phase==='pending permission')await page.evaluate(()=>window.__resolveMic());
    await page.waitForFunction(()=>window.__trackStops===1);
    assert.deepEqual(await page.evaluate(()=>({calls:window.__micCalls,starts:window.__recorderStarts,stops:window.__trackStops,state:window.__recorder?.state})),{calls:1,starts:phase==='recording'?1:0,stops:1,state:phase==='recording'?'inactive':undefined},'Stop immediately releases active tracks, or fences and releases a late permission grant without ever starting its recorder');
    assert.equal(await page.getByRole('button',{name:'Stop recording'}).count(),0);assert.equal(await page.getByText('Requesting microphone permission…').count(),0);assert.equal(await page.locator('.timber-audio-draft').count(),0,'Stop discards capture rather than publishing or submitting a review draft');
    assert.deepEqual(audioRequests,[],'neither audio upload nor paid POST is dispatched while Stop is unresolved');
    release();const response=await cancelled;assert.equal(response.status(),200);assert.equal(fixture.state.runs.get(BOT_A)[0].status,'cancelled');
    assert.deepEqual(audioRequests,[],'late run cancellation acknowledgement cannot restart capture or automatically admit audio');
    assert.equal(await page.evaluate(()=>window.__micCalls),1);assert.equal(await page.locator('.timber-audio-draft').count(),0);
  }finally{release();await context.close();await fixture.close();}
});
