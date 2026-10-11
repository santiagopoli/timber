import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createConsoleBrowser} from './console-browser.mjs';
import {createConsoleFixture,BOT_A,TEST_TOKEN} from './console-fixture.mjs';
import {makeToneWav} from './audio-wav.mjs';

const consoleBrowser=createConsoleBrowser(),date='2026-10-05T10:00:00.000Z',wav=makeToneWav(),longWav=makeToneWav({durationSeconds:31,sampleRate:8000,amplitudeModulationHz:0.1});
async function connectedPage({width=1280,height=900,initScript}={}){
  const fixture=await createConsoleFixture(),browser=await consoleBrowser(),loginWidth=width<600?1280:width;
  const context=await browser.newContext({viewport:{width:loginWidth,height}});if(initScript)await context.addInitScript(initScript);
  const page=await context.newPage();page.setDefaultTimeout(6000);
  // The shared fixture CSP predates audio. Production permits blob-backed media.
  // Extend only the test shell response; never modify the shared fixture.
  await page.route('**/console/',async route=>{const response=await route.fetch(),headers={...response.headers()};headers['content-security-policy']=(headers['content-security-policy']||'').replace('img-src',"media-src 'self' blob:; img-src");await route.fulfill({response,headers});});
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#message').waitFor();
  if(loginWidth!==width)await page.setViewportSize({width,height});
  return {fixture,context,page};
}
function audioMessage({audioId,operationId,attemptId,status='failed',text,error='Mock transcription failed safely.'}){
  return {id:'fixture-audio-message',botId:BOT_A,role:'user',text:'',createdAt:date,audio:{artifactId:audioId,mimeType:'audio/wav',size:wav.length,durationMs:800,operationId,transcription:{attemptId,status,...(text?{text}:{}),...(status==='failed'?{error}:{}),...(status==='uncertain'?{error:'The provider result is unknown.'}:{})}}};
}
async function installAudioMocks(page,{initialStatus='failed'}={}){
  const calls={uploads:[],submissions:[],retries:[],downloads:[]};
  await page.route(`**/v1/bots/${BOT_A}/audio/*`,async route=>{
    const request=route.request();if(request.method()==='PUT'){
      const audioBytes=await request.postDataBuffer();calls.uploads.push({url:request.url(),bodySize:audioBytes?.length||0,contentType:request.headers()['content-type'],body:audioBytes});
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({audio:{}})});return;
    }
    await route.fulfill({status:404,contentType:'application/json',body:'{}'});
  });
  await page.route(`**/v1/bots/${BOT_A}/audio-messages`,async route=>{
    const body=route.request().postDataJSON();calls.submissions.push(body);
    await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({message:audioMessage({audioId:body.audioId,operationId:body.operationId,attemptId:body.attemptId,status:initialStatus})})});
  });
  await page.route(`**/v1/bots/${BOT_A}/audio-messages/*/retry`,async route=>{
    const body=route.request().postDataJSON();calls.retries.push(body);const url=new URL(route.request().url()),operationId=decodeURIComponent(url.pathname.split('/').at(-2));
    await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({message:audioMessage({audioId:calls.submissions[0].audioId,operationId,attemptId:body.attemptId,status:'succeeded',text:'Turn left at the next street.'})})});
  });
  await page.route(`**/v1/bots/${BOT_A}/artifacts/*`,async route=>{calls.downloads.push(route.request().url());await route.fulfill({status:200,contentType:'audio/wav',headers:{'cache-control':'private, no-store'},body:wav});});
  return calls;
}
async function chooseTone(page,name='tone.wav'){
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach audio file'}).click();await(await chooser).setFiles({name,mimeType:'audio/wav',buffer:wav});await page.locator('.timber-audio-draft').waitFor();
}
async function confirmSend(page){await page.getByRole('button',{name:'Review & send'}).click();await page.getByRole('dialog').getByRole('button',{name:'Send audio'}).click();}

test('desktop draft/upload, decoded waveform, browser playback seek/pause and explicit paid retry',async()=>{
  const {fixture,context,page}=await connectedPage();
  try{
    const calls=await installAudioMocks(page);
    await chooseTone(page);assert.match(await page.locator('.timber-audio-composer').innerText(),/tone\.wav/);
    assert.equal(await page.locator('.timber-audio-draft audio').count(),1);assert.equal(calls.uploads.length,0,'file selection is local draft only');
    await page.getByRole('button',{name:'Cancel audio'}).click();assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(calls.uploads.length,0,'cancel never uploads');

    await chooseTone(page);await page.getByRole('button',{name:'Review & send'}).click();const consent=page.getByRole('dialog');
    await consent.waitFor();assert.match(await consent.innerText(),/billing is separate and actual charges may vary/);assert.equal(calls.uploads.length,0,'no paid request before consent');
    await consent.getByRole('button',{name:'Cancel'}).click();assert.equal(calls.uploads.length,0,'declining consent retains local draft only');await confirmSend(page);
    let message=page.locator('.timber-audio-message[data-transcription-status="failed"]');await message.waitFor();
    assert.equal(calls.uploads.length,1);assert.equal(calls.uploads[0].bodySize,wav.length,'original PCM WAV bytes uploaded intact');assert.equal(calls.submissions.length,1);
    for(const key of ['operationId','audioId','attemptId'])assert.ok(calls.submissions[0][key].length>0);

    const player=message.locator('.timber-audio-player');await message.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.timber-audio-message .timber-audio-player')?.dataset.waveform==='decoded');assert.equal(await player.getAttribute('data-waveform'),'decoded','a structurally validated PCM WAV must produce a signal-derived waveform');
    const bars=await player.locator('.timber-audio-wave i').evaluateAll(nodes=>nodes.map(node=>parseFloat(node.style.height)));
    assert.equal(bars.length,56);assert.ok(Math.max(...bars)>0);assert.ok(Math.max(...bars)-Math.min(...bars)>10,'bars vary from decoded PCM instead of repeated decorative heights');
    assert.ok(calls.downloads.some(url=>url.endsWith('/artifacts/'+calls.submissions[0].audioId)),'audio loads from authenticated artifact API');
    await message.getByRole('button',{name:'Play audio'}).click();await message.getByRole('button',{name:'Pause audio'}).waitFor();
    const seek=message.getByRole('slider',{name:'Seek audio'});await page.waitForFunction(()=>Number(document.querySelector('.timber-audio-message input[aria-label="Seek audio"]')?.value)>0.1,'',{timeout:5000});
    await seek.fill('0.45');await page.waitForFunction(()=>Math.abs(Number(document.querySelector('.timber-audio-message input[aria-label="Seek audio"]')?.value)-0.45)<0.03);
    await message.getByRole('button',{name:'Pause audio'}).click();assert.equal(await message.locator('audio').evaluate(audio=>audio.paused),true,'pause control pauses the actual browser media element');assert.equal(await message.getByRole('button',{name:'Play audio'}).isVisible(),true);

    const failed=message.locator('.timber-audio-failure');assert.match(await failed.innerText(),/Mock transcription failed safely/);assert.match(await failed.innerText(),/additional charges/);
    await failed.getByRole('button',{name:'Retry transcription'}).click();const retryDialog=page.getByRole('dialog');await retryDialog.waitFor();assert.match(await retryDialog.innerText(),/new paid attempt/i);assert.equal(calls.retries.length,0);
    await retryDialog.getByRole('button',{name:'Cancel'}).click();assert.equal(calls.retries.length,0,'retry cancellation makes no API call');
    await failed.getByRole('button',{name:'Retry transcription'}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm paid retry'}).click();
    await page.locator('.timber-audio-message[data-transcription-status="succeeded"]').waitFor();message=page.locator('.timber-audio-message[data-transcription-status="succeeded"]');assert.equal(calls.retries.length,1);assert.equal(calls.retries[0].acknowledgePaidRetry,true);assert.notEqual(calls.retries[0].attemptId,calls.submissions[0].attemptId);
    await page.getByRole('button',{name:'Show transcript'}).click();assert.equal(await page.getByText('Turn left at the next street.').isVisible(),true);
    await page.getByRole('button',{name:'Hide transcript'}).click();assert.equal(await page.getByText('Turn left at the next street.').isVisible(),false);assert.equal(await message.getByText(/Original audio · WAV · 0:00/).isVisible(),true);
  }finally{await context.close();await fixture.close();}
});

test('mobile permission is click-initiated, tracks are released on discard, and layout has no horizontal overflow',async()=>{
  const fakeMic=()=>{window.__micCalls=0;window.__trackStops=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micCalls++;return{getTracks:()=>[{stop(){window.__trackStops++;}}]};}}});window.MediaRecorder=class{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm;codecs=opus';start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};};
  const {fixture,context,page}=await connectedPage({width:390,height:844,initScript:fakeMic});
  try{
    await installAudioMocks(page);assert.equal(await page.evaluate(()=>window.__micCalls),0,'page load never asks for microphone permission');
    await page.getByRole('button',{name:'Start recording audio'}).click();await page.getByRole('button',{name:'Stop recording'}).waitFor();assert.equal(await page.evaluate(()=>window.__micCalls),1,'getUserMedia follows explicit user click');
    await page.getByRole('button',{name:'Discard'}).click();await page.waitForFunction(()=>window.__trackStops===1);assert.equal(await page.evaluate(()=>window.__trackStops),1,'discard stops every acquired track');
    const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,tools:document.querySelector('.timber-audio-tools')?.getBoundingClientRect().toJSON()}));
    assert.equal(geometry.scrollWidth,geometry.width);assert.ok(geometry.tools);assert.ok(geometry.tools.width<=390);
  }finally{await context.close();await fixture.close();}
});

test('pending status leaves original audio message visible and playable',async()=>{
  const {fixture,context,page}=await connectedPage();
  try{
    await installAudioMocks(page,{initialStatus:'pending'});await chooseTone(page,'processing.wav');await confirmSend(page);
    const message=page.locator('.timber-audio-message[data-transcription-status="pending"]');await message.waitFor();assert.match(await message.innerText(),/Transcription in progress/);
    await message.getByRole('button',{name:'Play audio'}).waitFor();assert.equal(await message.getByText(/Original audio · WAV · 0:00/).isVisible(),true);
  }finally{await context.close();await fixture.close();}
});

test('regular text chat still submits through existing messages API',async()=>{
  const {fixture,context,page}=await connectedPage({width:390,height:844});
  try{
    await page.locator('#message').fill('Text chat regression remains intact.');await page.getByRole('button',{name:'Send message'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length>=3);
    assert.ok(fixture.state.calls.some(call=>call.path.endsWith('/messages')&&call.method==='POST'&&call.body.text==='Text chat regression remains intact.'));
    assert.equal(await page.locator('.timber-audio-draft').count(),0);
  }finally{await context.close();await fixture.close();}
});


let validatorPromise;
async function sharedAudioValidator({instrument=false}={}){
  if(!instrument){validatorPromise??=build({entryPoints:[new URL('../../packages/contracts/src/audio-validation.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false}).then(({outputFiles})=>import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));return validatorPromise;}
  const filename=new URL('../../packages/contracts/src/audio-validation.ts',import.meta.url),source=await readFile(filename,'utf8');
  const marker='function check(ok: unknown): asserts ok {if (!ok) invalid();}';
  if(!source.includes(marker))throw new Error('Unable to instrument shared validator check function.');
  const debugSource=source.replace(marker,"function check(ok: unknown): asserts ok {if (!ok) {const failure=new Error('shared audio validator rejected this media structure');failure.name='AudioValidatorCheckFailure';throw failure;}}");
  process.setSourceMapsEnabled?.(true);
  const debugFile=`/tmp/timber-audio-validator-debug-${process.pid}-${Date.now()}.mjs`;
  await build({stdin:{contents:debugSource,sourcefile:filename.pathname,resolveDir:new URL('../../packages/contracts/src/',import.meta.url).pathname,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:debugFile,sourcemap:'inline',write:true});
  return import(`${pathToFileURL(debugFile).href}?instrumented`);
}

test('31-second PCM WAV produces a real waveform within the 10-minute/20-MB limits',async()=>{
  const {fixture,context,page}=await connectedPage();
  try{
    const calls=await installAudioMocks(page);
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach audio file'}).click();
    await(await chooser).setFiles({name:'long-tone-31s.wav',mimeType:'audio/wav',buffer:longWav});
    const draft=page.locator('.timber-audio-draft');await draft.waitFor();assert.match(await draft.innerText(),/long-tone-31s\.wav/);
    await page.waitForFunction(()=>document.querySelector('.timber-audio-draft .timber-audio-player')?.dataset.waveform==='decoded');
    const player=draft.locator('.timber-audio-player');assert.equal(await player.getAttribute('data-waveform'),'decoded');
    const bars=await player.locator('.timber-audio-wave i').evaluateAll(nodes=>nodes.map(node=>parseFloat(node.style.height)));
    assert.equal(bars.length,56);assert.ok(Math.max(...bars)-Math.min(...bars)>10,'31-second PCM samples produce signal-derived bars');
    assert.match(await draft.innerText(),/0:31/);assert.equal(calls.uploads.length,0);assert.equal(calls.submissions.length,0);assert.equal(calls.retries.length,0,'long local WAV selection is not a paid call');
    await page.getByRole('button',{name:'Review & send'}).click();await page.getByRole('dialog').waitFor();
    assert.equal(calls.uploads.length,0);assert.equal(calls.submissions.length,0,'no paid route is called before consent');
    await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();await page.getByRole('button',{name:'Cancel audio'}).click();
    assert.equal(await draft.count(),0);assert.equal(calls.uploads.length,0);assert.equal(calls.submissions.length,0);
  }finally{await context.close();await fixture.close();}
});

test('real Chromium MediaRecorder WebM draft passes the shared server audio validator',async()=>{
  const realMic=()=>{
    window.__micCalls=0;window.__audioContext=null;window.__oscillator=null;window.__recordingStream=null;window.__encodedChunks=[];window.__actualRecorderFile=null;const NativeFile=window.File;window.File=class extends NativeFile{constructor(...args){super(...args);if(typeof args[1]==='string'&&args[1].toLowerCase().endsWith('.webm'))window.__actualRecorderFile=this;}};const NativeMediaRecorder=window.MediaRecorder;window.MediaRecorder=class extends NativeMediaRecorder{constructor(...args){super(...args);this.addEventListener('dataavailable',event=>{if(event.data?.size)window.__encodedChunks.push(event.data);});}};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async constraints=>{
      window.__micCalls++;if(!constraints?.audio)throw new Error('Expected audio capture.');
      const context=new AudioContext();await context.resume();const destination=context.createMediaStreamDestination(),oscillator=context.createOscillator();
      oscillator.type='sine';oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();
      window.__audioContext=context;window.__oscillator=oscillator;window.__recordingStream=destination.stream;return destination.stream;
    }}});
  };
  const {fixture,context,page}=await connectedPage({initScript:realMic});
  try{
    const calls=await installAudioMocks(page,{initialStatus:'pending'});
    assert.equal(await page.evaluate(()=>window.__micCalls),0,'permission mock is not invoked during page initialization');
    await page.getByRole('button',{name:'Start recording audio'}).click();
    await page.getByRole('button',{name:'Stop recording'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__micCalls),1,'record button is the only permission-request entry point');
    assert.equal(await page.evaluate(()=>MediaRecorder.isTypeSupported('audio/webm;codecs=opus')),true,'this test requires actual Chromium WebM/Opus MediaRecorder support');
    await page.waitForTimeout(900);
    await page.getByRole('button',{name:'Stop recording'}).click();
    await page.locator('.timber-audio-draft').waitFor().catch(async error=>{await page.waitForFunction(()=>window.__actualRecorderFile?.size>0,{timeout:2000}).catch(()=>{});const info=await page.evaluate(async()=>{const file=window.__actualRecorderFile,bytes=file?new Uint8Array(await file.arrayBuffer()):new Uint8Array();return{size:bytes.length,type:file?.type,chunks:window.__encodedChunks.length,base64:btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''))};});const debug=await sharedAudioValidator({instrument:true}),bytes=Buffer.from(info.base64,'base64');await writeFile(`/tmp/timber-chromium-onstop-${process.pid}.webm`,bytes);let validator;try{validator=debug.validateAudio(new Uint8Array(bytes),info.type||'audio/webm');}catch(reason){validator={error:String(reason),name:reason?.name,stack:reason?.stack,code:reason?.code};}throw new Error(`${error.message}; composer=${await page.locator('.timber-audio-composer').innerText()}; exact-onstop-file=${JSON.stringify({...info,base64:undefined,validator})}; saved=/tmp/timber-chromium-onstop-${process.pid}.webm`);});
    assert.match(await page.locator('.timber-audio-draft').innerText(),/Recording-.*\.webm/,'real recorder output becomes a playable WebM draft');
    const exactClip=Buffer.from(await page.evaluate(async()=>{const bytes=new Uint8Array(await window.__actualRecorderFile.arrayBuffer());return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));}),'base64');
    const samplePath=`/tmp/timber-audio-mediarecorder-${process.pid}.webm`;await writeFile(samplePath,exactClip);
    assert.ok(exactClip.length>0,`captured exact File constructed from onstop clip at ${samplePath}`);
    const actualWebmPlayer=page.locator('.timber-audio-draft .timber-audio-player');
    await actualWebmPlayer.getByRole('button',{name:'Play audio'}).click();await actualWebmPlayer.getByRole('button',{name:'Pause audio'}).waitFor();
    await actualWebmPlayer.getByRole('slider',{name:'Seek audio'}).fill('0.45');
    await page.waitForFunction(()=>{const audio=document.querySelector('.timber-audio-draft audio');return audio&&audio.currentTime>=0.4;},undefined,{timeout:5000});
    assert.ok(await page.locator('.timber-audio-draft audio').evaluate(audio=>Math.abs(audio.currentTime-0.45)<0.08),'seeking moves the real WebM-backed audio element');
    await actualWebmPlayer.getByRole('button',{name:'Pause audio'}).click();assert.equal(await page.locator('.timber-audio-draft audio').evaluate(audio=>audio.paused),true,'the real WebM draft pauses after seeking');
    assert.equal(calls.uploads.length,0,'recording creates no upload until the paid transcription warning is confirmed');
    await confirmSend(page);
    await page.locator('.timber-audio-message[data-transcription-status="pending"]').waitFor();
    assert.equal(calls.uploads.length,1);assert.ok(calls.uploads[0].bodySize>0);assert.deepEqual(calls.uploads[0].body,exactClip,'uploaded bytes are the exact preflighted onstop File buffer');
    const {validateAudio}=await sharedAudioValidator();
    const metadata=validateAudio(new Uint8Array(calls.uploads[0].body),calls.uploads[0].contentType);
    assert.equal(metadata.mimeType,'audio/webm','the shared server validator accepts the browser MIME and parsed WebM container');
    assert.ok(metadata.durationMs>=500&&metadata.durationMs<=5_000,`parsed packet duration is bounded and plausible: ${metadata.durationMs}ms`);
    assert.equal(await page.evaluate(()=>window.__micCalls),1,'upload does not request another microphone permission');
    assert.ok(await page.evaluate(()=>window.__recordingStream.getTracks().every(track=>track.readyState==='ended')),'stop releases the real MediaRecorder microphone stream tracks');
  }finally{
    await page.evaluate(async()=>{try{window.__oscillator?.stop();}catch{}await window.__audioContext?.close();}).catch(()=>{});
    await context.close();await fixture.close();
  }
});
