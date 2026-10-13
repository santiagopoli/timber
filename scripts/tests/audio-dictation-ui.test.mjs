import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {existsSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import {webkit} from 'playwright';
import {createConsoleBrowser} from './console-browser.mjs';
import {createConsoleFixture,BOT_A,BOT_B,TEST_TOKEN} from './console-fixture.mjs';

// Actual bundled composer/capture/insertion/transport, with synthetic PCM input
// and local backend receipts. NOT physical Safari/iPhone, OS microphone, or paid
// provider coverage. Fail closed on every non-fixture network destination.
const chromiumBrowser=createConsoleBrowser();let webkitOpening;
after(async()=>{if(webkitOpening)await(await webkitOpening).close();});
const browserFor=engine=>engine==='chromium'?chromiumBrowser():(webkitOpening??=webkit.launch({headless:true,...(process.env.CONSOLE_WEBKIT_PATH?{executablePath:process.env.CONSOLE_WEBKIT_PATH}:{})}));
const date='2026-10-05T10:00:00.000Z',TASK_A='10000000-0000-4000-8000-000000000091',TASK_B='10000000-0000-4000-8000-000000000092',transcript='spoken words';
const fixtureMocks=new WeakMap(),fixtureBackends=new WeakMap();
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
function syntheticPcmMic(){
  window.__micCalls=0;window.__trackStops=0;window.__contextCloses=0;window.__recorderStarts=0;window.__dictationAborts=0;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async constraints=>{
    if(!constraints.audio||constraints.video!==false)throw new Error('Audio-only permission expected');window.__micCalls++;
    return{getTracks:()=>[{stop(){window.__trackStops++;}}]};
  }}});
  // An MP4-only negotiation outcome must take supported WAV/PCM capture, not
  // construct or relabel MP4. Encoder, validation and waveform remain real.
  window.MediaRecorder=class{static isTypeSupported=type=>type==='audio/mp4';constructor(){window.__recorderStarts++;throw new Error('Unsupported MP4 capture');}};
  const node=()=>({connect(){},disconnect(){this.disconnected=true;}});
  window.AudioContext=class{
    state='running';sampleRate=48000;destination={};resume(){return Promise.resolve();}
    close(){this.state='closed';window.__contextCloses++;return Promise.resolve();}
    createMediaStreamSource(){return window.__pcmSource=node();}
    createGain(){return window.__pcmGain={...node(),gain:{value:1}};}
    createScriptProcessor(){return window.__pcmProcessor={...node(),onaudioprocess:null};}
  };
  // Observe the real transport's cancellation signal, without replacing fetch.
  const fetch=window.fetch;window.fetch=function(input,init){
    const url=String(input instanceof Request?input.url:input);
    if(/\/dictations(?:\/|$)/.test(url)&&init?.signal){
      if(init.signal.aborted)window.__dictationAborts++;
      else init.signal.addEventListener('abort',()=>window.__dictationAborts++,{once:true});
    }return fetch.call(this,input,init);
  };
}
async function installTasks(page){
  // Minimal file-local task fixture; no task creation, model or computer work.
  const records=[TASK_A,TASK_B].map((id,index)=>({id,title:`Dictation task ${index+1}`,description:'Fixture-only independent draft',botId:BOT_A,botName:'Ada',status:'queued',createdAt:date}));
  await page.route('**/v1/tasks**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/v1/tasks')return json(route,{tasks:records});
    const[,id,tail='']=/^\/v1\/tasks\/([^/]+)(.*)$/.exec(path)||[],task=records.find(item=>item.id===id);
    if(!task)return json(route,{},404);
    if(route.request().method()!=='GET')return json(route,{error:{code:'fixture_unexpected_mutation',message:'No task admission allowed.'}},500);
    if(!tail)return json(route,{task});
    if(tail==='/messages')return json(route,{messages:[],nextCursor:null});
    if(tail==='/runs')return json(route,{runs:[],activeRuns:[],nextCursor:null});
    if(tail==='/approvals')return json(route,{approvals:[]});
    if(tail==='/agents')return json(route,{agents:[],delegations:[]});
    if(tail==='/connections')return json(route,{connections:[]});
    if(tail==='/keychain')return json(route,{entries:[],requests:[]});
    if(tail==='/computer')return json(route,{computer:{id:`task:${id}`,provider:'cloudflare',state:'stopped'}});
    if(tail==='/context')return json(route,{context:{automatic:true,estimatedTokens:0,activeEntries:0,contextWindow:200000,compactions:[]}});
    if(tail==='/events')return new URL(route.request().url()).searchParams.get('format')==='json'?json(route,{events:[],nextCursor:null}):route.fulfill({status:200,contentType:'text/event-stream',body:''});
    return json(route,{});
  });
}
async function createRawAudioFixture(){
  const fixture=await createConsoleFixture(),originalURL=fixture.url,originalClose=fixture.close,originalOrigin=new URL(originalURL).origin;
  assert.equal(new URL(originalURL).protocol,'http:');assert.equal(new URL(originalURL).hostname,'127.0.0.1','upstream fixture must remain loopback');
  const backend={mock:null};
  // WebKit's interception protocol does not expose Blob PUT postDataBuffer.
  // Capture actual browser-sent bytes at a loopback HTTP front end instead;
  // every other request still runs the existing console fixture unchanged.
  const server=createServer(async(incoming,response)=>{
    let target;try{target=new URL(incoming.url,originalURL);}catch{response.writeHead(400).end('Invalid fixture path');return;}
    // Reject absolute/network-path external targets before forwarding any
    // request, headers or cookies; the raw fixture is never an open proxy.
    if(target.origin!==originalOrigin){response.writeHead(400).end('Fixture origin only');return;}
    const path=target.pathname;
    if(incoming.method==='PUT'&&/^\/v1\/(bots|tasks)\/[^/]+\/(audio|dictation-audio)\/[^/]+$/.test(path)){
      try{
        assert.ok(backend.mock,'raw upload must belong to an installed dictation fixture');
        const session=/(?:^|;\s*)timber_fixture_session=([^;]+)/.exec(incoming.headers.cookie||'')?.[1];
        assert.ok(session&&fixture.state.sessions.has(session)&&!fixture.state.rejectAuth,'raw audio uses the current authenticated fixture session');
        assert.equal(incoming.headers['x-timber-client'],'console');assert.equal(incoming.headers.authorization,undefined);assert.equal(incoming.headers['content-type'],'audio/wav');
        let size=0;const chunks=[];
        for await(const chunk of incoming){size+=chunk.length;assert.ok(size<=20_000_000,'wire audio stays within 20MB');chunks.push(chunk);}
        const bytes=Buffer.concat(chunks);assert.ok(bytes.length>44,'wire upload contains WAV samples');assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
        backend.mock.uploads.push({path,bytes,contentType:incoming.headers['content-type'],headers:{...incoming.headers}});
        response.writeHead(201,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({audio:{artifactId:path.split('/').at(-1),mimeType:'audio/wav',size:bytes.length,durationMs:1024}}));
      }catch(error){fixture.state.failures.push(String(error));incoming.resume();response.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'fixture_raw_upload_failed',message:'Raw WAV fixture assertion failed.'}}));}
      return;
    }
    const upstream=httpRequest(target,{method:incoming.method,headers:{...incoming.headers,host:target.host}},received=>{
      response.writeHead(received.statusCode,received.headers);received.pipe(response);
    });
    upstream.on('error',error=>{if(!response.destroyed){fixture.state.failures.push(String(error));if(!response.headersSent)response.writeHead(502);response.end();}});
    incoming.on('aborted',()=>upstream.destroy());response.on('close',()=>upstream.destroy());incoming.pipe(upstream);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fixture.url=`http://127.0.0.1:${server.address().port}/console/`;fixture.state.consoleOrigin=new URL(fixture.url).origin;
  fixture.close=async()=>{server.closeAllConnections();try{await new Promise(resolve=>server.close(resolve));}finally{await originalClose();}};
  return{fixture,backend};
}
async function connectedPage(engine,{tasks=false,initialHistory,viewport={width:1280,height:900}}={}){
  const{fixture,backend}=await createRawAudioFixture();let context,page;
  try {
  const browser=await browserFor(engine);context=await browser.newContext({serviceWorkers:'block',viewport});
  if(initialHistory)fixture.state.messages.set(BOT_A,initialHistory);
  await context.addInitScript(syntheticPcmMic);page=await context.newPage();page.setDefaultTimeout(6000);fixtureBackends.set(page,backend);
  const traffic=[],external=[],errors=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/v1/'))traffic.push({method:request.method(),path:url.pathname});});
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(fixture.url).origin)return route.fallback();external.push(url.origin);return route.abort('blockedbyclient');});
  await page.route('**/console/',async route=>{const response=await route.fetch(),headers={...response.headers()};headers['content-security-policy']=(headers['content-security-policy']||'').replace('img-src',"media-src 'self' blob:; img-src");return route.fulfill({response,headers});});
  if(tasks)await installTasks(page);
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();if(viewport.width<=760)await page.locator(`#bot-list button[data-bot-id="${BOT_A}"]`).click();await page.locator('#message').waitFor();
  const env={fixture,context,page,traffic,primaryError:null,recordFailure:async error=>{
    env.primaryError=error;
    let ui;try{ui={errors:await page.locator('.timber-audio-error').allTextContents(),draft:await page.locator('#message:visible').evaluateAll(nodes=>nodes.map(node=>node.value??node.innerText))};}catch{ui={closed:true};}
    // Only fixture paths/counts and composer text; never headers or raw PCM.
    const mocks=(fixtureMocks.get(page)||[]).map(calls=>({uploads:calls.uploads.map(item=>item.path),posts:calls.posts.map(item=>item.path),checks:calls.checks,deletes:calls.deletes}));
    error.message+=`\nFixture diagnostics: ${JSON.stringify({traffic,mocks,ui})}`;
  },close:async()=>{
    try{
      try{await context.close();}finally{await fixture.close();}
      assert.deepEqual(external,[],'all network stays in loopback fixture');assert.deepEqual(errors,[],'no browser exceptions');assert.deepEqual(fixture.state.failures,[]);
    }catch(error){
      if(env.primaryError)throw new AggregateError([env.primaryError,error],`Primary test failure: ${env.primaryError.message}; cleanup also failed: ${error.message}`,{cause:env.primaryError});
      throw error;
    }
  }};return env;
  } catch(error) {
    // Initialization can fail before the scenario owns env. Always release the
    // context and both loopback servers; preserve the original assertion.
    let ui;try{ui={view:await page.locator('body').getAttribute('data-main-view'),loginError:await page.locator('#login-error').textContent(),messageCount:await page.locator('#message').count()};}catch{ui={closed:true};}
    error.message+=`\nFixture initialization diagnostics: ${JSON.stringify(ui)}`;
    try{await context?.close();}finally{await fixture.close();}
    console.error(error.message);throw error;
  }
}
async function installDictationMocks(page,{hold=false,status='succeeded',text=transcript}={}){
  const gate=deferred(),submitted=deferred(),handled=deferred(),calls={uploads:[],posts:[],checks:[],deletes:[],discards:[],unexpected:[]};let currentStatus=status,currentText=text;
  const receipt=body=>({operationId:body.operationId,audioId:body.audioId,transcription:{attemptId:body.attemptId,status:currentStatus,...(currentStatus==='succeeded'?{text:currentText}:{}),...(currentStatus==='uncertain'?{errorCode:'transcription_uncertain',error:'Provider result is unknown; inspect the existing attempt.'}:{})}});
  fixtureMocks.set(page,[...(fixtureMocks.get(page)||[]),calls]);fixtureBackends.get(page).mock=calls;
  // Registered after tasks: only audio/dictation requests are claimed here.
  await page.route(/\/v1\/(?:bots|tasks)\/[^/]+\/(?:dictations(?:\/[^/]+)?|(?:audio|dictation-audio)\/[^/]+|audio-messages(?:\/[^/]+)?)$/,async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    if(/\/audio-messages(?:\/|$)/.test(path)){calls.unexpected.push({path,method});return json(route,{error:{code:'fixture_wrong_voice_mode',message:'Dictation must not create an audio message.'}},500);}
    if(/^\/v1\/(bots|tasks)\/[^/]+\/(audio|dictation-audio)\/[^/]+$/.test(path)){
      if(method==='PUT')return route.continue(); // Actual raw Blob reaches only the file-local loopback WAV handler.
      if(method==='DELETE'){calls.discards.push({path,method});return json(route,{discarded:true});}return json(route,{},404);
    }
    if(!/^\/v1\/(bots|tasks)\/[^/]+\/dictations(?:\/[^/]+)?$/.test(path))return route.fallback();
    if(method==='POST'){
      const body=request.postDataJSON();calls.posts.push({path,body,headers:request.headers()});submitted.resolve(body);if(hold)await gate.promise;
      try{return await json(route,receipt(body),202);}catch(error){if(!request.failure())throw error;}finally{handled.resolve();}
    }
    if(method==='GET'){calls.checks.push({path,method});const original=calls.posts[0]?.body;return original?json(route,receipt(original)):json(route,{error:{code:'not_found',message:'No receipt.'}},404);}
    if(method==='DELETE'){calls.deletes.push({path,method});return json(route,{cancelled:true});}
    calls.unexpected.push({path,method});return json(route,{},500);
  });
  const observe=async(promise,label)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(async()=>{
      let ui;try{ui=await page.locator('.timber-audio-error').allTextContents();}catch{ui=['page closed'];}
      reject(new Error(`${label} was not observed within 6000ms; route calls=${JSON.stringify({uploads:calls.uploads.map(item=>item.path),posts:calls.posts,checks:calls.checks})}; UI=${JSON.stringify(ui)}`));
    },6000);})]);}finally{clearTimeout(timer);}
  };
  return{calls,waitSubmitted:()=>observe(submitted.promise,'Dictation POST'),waitHandled:()=>observe(handled.promise,'Held receipt fulfilment'),release:gate.resolve,setReceipt:(status,text=transcript)=>{currentStatus=status;currentText=text;}};
}
const draft=page=>page.locator('#message:visible');
async function selectRange(page,start,end=start){await draft(page).evaluate((node,{start,end})=>{node.focus();node.setSelectionRange(start,end);node.dispatchEvent(new Event('select',{bubbles:true}));},{start,end});}
async function expectDraft(page,text){await page.waitForFunction(text=>Array.from(document.querySelectorAll('#message')).find(node=>node.offsetParent!==null&&!node.disabled)?.value===text,text);assert.equal(await draft(page).inputValue(),text);}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function beginPcm(page){
  assert.match(await page.getByRole('button',{name:'Dictate text',exact:true}).getAttribute('title'),/separately billed.*nothing is sent/i,'dictation billing and explicit message-send distinction are available contextually');
  await page.getByRole('button',{name:'Dictate text',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();
  await page.evaluate(()=>{for(let chunk=0;chunk<12;chunk++){const data=Float32Array.from({length:4096},(_,i)=>Math.sin((chunk*4096+i)*2*Math.PI*440/48000)*(0.15+chunk/30));window.__pcmProcessor.onaudioprocess?.({inputBuffer:{getChannelData:()=>data}});}});
}
async function stopForTranscription(page,mock){
  const released=await page.evaluate(()=>({tracks:window.__trackStops+1,contexts:window.__contextCloses+1}));
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.waitForFunction(({tracks,contexts})=>window.__trackStops===tracks&&window.__contextCloses===contexts,released);
  assert.ok(await page.evaluate(()=>window.__pcmProcessor.disconnected&&window.__pcmSource.disconnected&&window.__pcmGain.disconnected),'Stop disconnects all PCM capture nodes');
  assert.equal(await page.getByRole('dialog').count(),0,'Stop transcribes directly without a consent or review modal');
  assert.equal(await page.locator('.timber-audio-draft').count(),0,'dictation never creates a voice-note preview');
  await mock.waitSubmitted();
  assert.equal(mock.calls.posts.length,1,'Stop submits exactly one transcription, not a message');
  assert.equal(mock.calls.uploads.length,1);
  assertWavUpload(mock,mock.calls.posts[0].path.replace(/\/dictations$/,''));
}
function assertNoAdmission(env,mock){
  assert.deepEqual(mock.calls.unexpected,[],'never uses audio-messages');
  assert.deepEqual(env.traffic.filter(call=>call.method==='POST'&&/\/(messages|audio-messages|continue|runs)(?:\/|$)/.test(call.path)),[],'no normal/task/audio message or run admission');
  assert.equal(env.fixture.state.runs.get(BOT_A).length,0);assert.equal(env.fixture.state.runs.get(BOT_B).length,0);assert.equal(env.fixture.state.messages.get(BOT_A).length,2);assert.equal(env.fixture.state.messages.get(BOT_B).length,0);
}
function assertWavUpload(mock,base){
  const{uploads,posts}=mock.calls;assert.equal(uploads.length,1);assert.equal(posts.length,1);const{bytes,contentType,path,headers}=uploads[0];
  assert.equal(contentType,'audio/wav');assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(34),16);assert.ok(bytes.length>44&&bytes.length<=20_000_000);assert.ok(bytes.subarray(44).some(byte=>byte!==0),'recording contains fixture signal');
  const{body}=posts[0];assert.deepEqual(Object.keys(body).sort(),['attemptId','audioId','operationId']);for(const id of Object.values(body))assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(posts[0].path,`${base}/dictations`);assert.equal(path,`${base}/${base.includes('/tasks/')?'dictation-audio':'audio'}/${body.audioId}`);
  assert.equal(headers['x-timber-client'],'console');assert.ok(headers.cookie);assert.equal(headers.authorization,undefined);assert.equal(posts[0].headers['x-timber-client'],'console');assert.equal(posts[0].headers.authorization,undefined);
}
async function openTask(page,id=TASK_A){if(!await page.locator('#tasks-nav').isVisible())await page.locator('#toggle-bots').click();await page.locator('#tasks-nav').click();await page.locator(`.timber-tasks-card[data-task-id="${id}"]`).click();await page.locator(`.timber-tasks-detail[data-task-id="${id}"] #message`).waitFor();}
async function returnToBots(page,id=BOT_A){await page.locator('#bots-nav').click();await page.locator(`#bot-list button[data-bot-id="${id}"]`).click();await draft(page).waitFor();}

for(const engine of ['chromium','webkit']){
  const options={skip:engine==='webkit'&&!existsSync(process.env.CONSOLE_WEBKIT_PATH||webkit.executablePath())?'WebKit executable unavailable; synthetic Chromium is not physical Safari/iPhone coverage':false};
  const scenario=(name,work)=>test(`${engine}: real dictation UI with synthetic PCM — ${name}`,options,work);
  scenario('completed voice inserts editable text, preserves existing draft, and never auto-sends',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page),{page}=env;
    try{
      assert.equal(await page.evaluate(()=>window.__micCalls),0);await draft(page).fill('Existing draft');await selectRange(page,14);await beginPcm(page);
      assert.equal(await draft(page).isEnabled(),true,'capture keeps text editable');assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
      assert.equal(mock.calls.uploads.length,0);assert.equal(mock.calls.posts.length,0,'capture remains local until Stop');await stopForTranscription(page,mock);await expectDraft(page,`Existing draft ${transcript}`);
      assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(await page.locator('.timber-audio-message').count(),0);assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);
      await selectRange(page,(await draft(page).inputValue()).length);await page.keyboard.type(' edited');await expectDraft(page,`Existing draft ${transcript} edited`);
      assertWavUpload(mock,`/v1/bots/${BOT_A}`);assertNoAdmission(env,mock);assert.equal(await page.evaluate(()=>window.__recorderStarts),0);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('selected original words survive; transcript inserts after selection end with separation',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page),{page}=env;
    try{await draft(page).fill('alpha selected omega');await selectRange(page,6,14);await beginPcm(page);await stopForTranscription(page,mock);await expectDraft(page,`alpha selected ${transcript} omega`);assertNoAdmission(env,mock);}catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('concurrent edits before/after anchor and active user selection are retained',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{hold:true}),{page}=env;
    try{
      await draft(page).fill('alpha selected omega');await selectRange(page,6,14);await beginPcm(page);await stopForTranscription(page,mock);await mock.waitSubmitted();
      assert.equal(await draft(page).isEnabled(),true,'transcription keeps text editable');assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
      await selectRange(page,0);await page.keyboard.type('PRE ');await selectRange(page,(await draft(page).inputValue()).length);await page.keyboard.type(' POST');await expectDraft(page,'PRE alpha selected omega POST');await selectRange(page,19,24);
      mock.release();await mock.waitHandled();await expectDraft(page,`PRE alpha selected ${transcript} omega POST`);
      assert.deepEqual(await draft(page).evaluate(node=>({text:node.value.slice(node.selectionStart,node.selectionEnd),focused:node===document.activeElement})),{text:'omega',focused:true},'insertion transforms selection without disturbing ongoing editing');assertNoAdmission(env,mock);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('late insertion never refocuses after user moves to another control',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{hold:true}),{page}=env;
    try{await draft(page).fill('keep');await selectRange(page,4);await beginPcm(page);await stopForTranscription(page,mock);await mock.waitSubmitted();await page.locator('#settings-button').focus();mock.release();await mock.waitHandled();await expectDraft(page,`keep ${transcript}`);assert.equal(await page.locator('#settings-button').evaluate(node=>node===document.activeElement),true);assertNoAdmission(env,mock);}catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('Enter is newline during capture/transcription; explicit Send posts exactly one normal message',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{hold:true}),{page}=env;
    try{
      await draft(page).fill('Existing draft suffix');await selectRange(page,14);await beginPcm(page);await selectRange(page,21);await page.keyboard.press('Enter');await page.keyboard.type('live');await expectDraft(page,'Existing draft suffix\nlive');
      await stopForTranscription(page,mock);await mock.waitSubmitted();await selectRange(page,(await draft(page).inputValue()).length);await page.keyboard.press('Enter');await page.keyboard.type('pending');await expectDraft(page,'Existing draft suffix\nlive\npending');assertNoAdmission(env,mock);
      mock.release();await mock.waitHandled();const expected=`Existing draft ${transcript} suffix\nlive\npending`;await expectDraft(page,expected);assertNoAdmission(env,mock);await selectRange(page,expected.length);await page.keyboard.type(' edited');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.locator('[data-message-id]').filter({hasText:`${expected} edited`}).waitFor();
      const sends=env.fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`);assert.equal(sends.length,1);assert.equal(sends[0].body.text,`${expected} edited`);assert.equal(env.fixture.state.runs.get(BOT_A).length,1);assert.equal(mock.calls.posts.length,1);assert.deepEqual(mock.calls.unexpected,[]);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('recording cancel immediately releases capture with zero upload or paid API requests',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page),{page}=env;
    try{await draft(page).fill('preserve this draft');await beginPcm(page);await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();await page.waitForFunction(()=>window.__trackStops===1&&window.__contextCloses===1);await expectDraft(page,'preserve this draft');assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(await page.getByRole('button',{name:'Stop recording',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);assert.deepEqual(mock.calls,{uploads:[],posts:[],checks:[],deletes:[],discards:[],unexpected:[]});assertNoAdmission(env,mock);}catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('pending cancel aborts transport and fences a late successful receipt',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{hold:true}),{page}=env;
    try{
      await draft(page).fill('original draft');await selectRange(page,14);await beginPcm(page);await stopForTranscription(page,mock);const body=await mock.waitSubmitted();await draft(page).fill('newer user draft');await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();await page.waitForFunction(()=>window.__dictationAborts>0);await expectDraft(page,'newer user draft');
      mock.release();await mock.waitHandled();await settle(page);await expectDraft(page,'newer user draft');assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(mock.calls.posts.length,1);assert.equal(mock.calls.uploads.length,1);assert.equal(mock.calls.checks.length,1,'only the pre-dispatch receipt lookup; cancel does not recover or retry');assert.ok(mock.calls.deletes.every(call=>call.path.endsWith(`/dictations/${body.operationId}`)));assertNoAdmission(env,mock);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  for(const destination of ['bot','task'])scenario(`navigation to another ${destination} fences pending success and preserves destination draft`,async()=>{
    const env=await connectedPage(engine,{tasks:destination==='task'}),mock=await installDictationMocks(env.page,{hold:true}),{page}=env;
    try{
      await draft(page).fill('Ada original draft');await selectRange(page,18);await beginPcm(page);await stopForTranscription(page,mock);await mock.waitSubmitted();
      if(destination==='bot'){await page.locator(`#bot-list button[data-bot-id="${BOT_B}"]`).click();await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();}else await openTask(page);
      await draft(page).fill('independent destination draft');await page.waitForFunction(()=>window.__dictationAborts>0);mock.release();await mock.waitHandled();await settle(page);await expectDraft(page,'independent destination draft');assert.equal(await page.locator('.timber-audio-draft').count(),0);assertNoAdmission(env,mock);
      if(destination==='task')await returnToBots(page);else{await page.locator(`#bot-list button[data-bot-id="${BOT_A}"]`).click();await page.locator('#selected-name').filter({hasText:'Ada'}).waitFor();}await expectDraft(page,'Ada original draft');assert.equal(mock.calls.posts.length,1);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  for(const sessionEnd of ['logout','expired session'])scenario(`${sessionEnd} aborts pending dictation; new login cannot consume late success`,async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{hold:true}),logoutGate=deferred(),{page}=env;
    try{
      await draft(page).fill('old session draft');await beginPcm(page);await stopForTranscription(page,mock);await mock.waitSubmitted();
      if(sessionEnd==='logout'){
        await page.route('**/v1/session',async route=>{if(route.request().method()!=='DELETE')return route.fallback();await logoutGate.promise;return route.continue();});await page.locator('#disconnect').evaluate(node=>node.click());await page.waitForFunction(()=>window.__dictationAborts>0);assert.equal(await page.locator('.timber-audio-draft').count(),0,'cancel precedes session DELETE acknowledgement');logoutGate.resolve();
      }else{env.fixture.state.rejectAuth=true;await page.locator('#refresh-history').evaluate(node=>node.click());}
      await page.locator('#login').waitFor({state:'visible'});await page.waitForFunction(()=>window.__dictationAborts>0);env.fixture.state.rejectAuth=false;await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await draft(page).waitFor();await draft(page).fill('new session draft');
      mock.release();await mock.waitHandled();await settle(page);await expectDraft(page,'new session draft');assert.equal(await page.locator('.timber-audio-draft').count(),0);assert.equal(mock.calls.posts.length,1);assertNoAdmission(env,mock);
    }catch(error){await env.recordFailure(error);throw error;}finally{logoutGate.resolve();mock.release();await env.close();}
  });
  scenario('uncertain never auto-retries paid work; explicit status check keeps original operation/attempt',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page,{status:'uncertain'}),{page}=env;
    try{
      await draft(page).fill('keep uncertain draft');await selectRange(page,20);await beginPcm(page);await page.clock.install();await stopForTranscription(page,mock);const body=await mock.waitSubmitted();await page.getByRole('button',{name:'Check transcription status',exact:true}).waitFor();await page.clock.fastForward(30000);await expectDraft(page,'keep uncertain draft');assert.equal(mock.calls.posts.length,1);assert.equal(mock.calls.uploads.length,1);assert.equal(mock.calls.checks.length,1,'only the original pre-dispatch lookup; no automatic uncertain polling/retry');assertNoAdmission(env,mock);
      mock.setReceipt('succeeded');await page.getByRole('button',{name:'Check transcription status',exact:true}).click();await expectDraft(page,`keep uncertain draft ${transcript}`);assert.deepEqual(mock.calls.checks,[{path:`/v1/bots/${BOT_A}/dictations/${body.operationId}`,method:'GET'},{path:`/v1/bots/${BOT_A}/dictations/${body.operationId}`,method:'GET'}]);assert.equal(mock.calls.posts.length,1);assert.equal(mock.calls.uploads.length,1);assert.equal(mock.calls.posts[0].body.attemptId,body.attemptId);assertNoAdmission(env,mock);
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('opaque private reference survives dictation and ongoing secure-composer edits',async()=>{
    const env=await connectedPage(engine),mock=await installDictationMocks(env.page),{page}=env;
    const id='20000000-0000-4000-8000-000000000001',reference=`[private:${id}]`;
    try{
      // Existing metadata only. No credential value is read, saved or invented.
      await page.route(`**/v1/bots/${BOT_A}/keychain`,route=>json(route,{entries:[{id,name:'Fixture private reference',origin:'',header:'',prefix:'',revision:1,botIds:[BOT_A],createdAt:date,updatedAt:date}],requests:[]}));
      await draft(page).fill('before ');await selectRange(page,7);await page.getByRole('button',{name:'Your keychain',exact:true}).click();
      await page.getByRole('dialog',{name:'Your keychain',exact:true}).getByRole('button',{name:'Insert',exact:true}).click();
      const editor=page.locator('#message[contenteditable=true]');await editor.waitFor();
      const hidden=page.locator('#message-form input[name=message]');
      await page.waitForFunction(reference=>document.querySelector('#message-form input[name=message]')?.value===`before ${reference}`,reference);
      await editor.evaluate(node=>{node.focus();const range=document.createRange();range.setStartAfter(node.querySelector('.timber-private-chip'));range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'}));});
      await editor.pressSequentially(' after');
      // Selecting the opaque pill must not replace or split its reference.
      await editor.evaluate(node=>{node.focus();const range=document.createRange();range.selectNode(node.querySelector('.timber-private-chip'));getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'}));});
      await beginPcm(page);assert.equal(await editor.getAttribute('contenteditable'),'true');
      await editor.evaluate(node=>{node.focus();const range=document.createRange();range.selectNodeContents(node);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'End'}));});
      await editor.pressSequentially(' live');await stopForTranscription(page,mock);
      const expected=`before ${reference} ${transcript} after live`;
      await page.waitForFunction(text=>document.querySelector('#message-form input[name=message]')?.value===text,expected);assert.equal(await hidden.inputValue(),expected);
      assert.equal(await editor.locator('.timber-private-chip').count(),1);assert.equal(await editor.locator('.timber-private-chip').getAttribute('data-secure-ref'),reference);
      assert.equal(await editor.innerText().then(text=>text.includes('[private:')),false);assert.ok((await editor.innerText()).includes(transcript));assertNoAdmission(env,mock);
      assert.equal(env.traffic.filter(call=>call.method!=='GET'&&call.path.includes('/keychain')).length,0,'dictation does not write, grant or reveal private inputs');
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
  scenario('synchronous review resize and upward scroll preserve reading intent before observer follow writes',async()=>{
    const initialHistory=Array.from({length:40},(_,index)=>({id:`resize-race-history-${index}`,botId:BOT_A,role:index%2?'assistant':'user',text:`History entry ${index}.\n\n${'Fixture reading history paragraph. '.repeat(12)}`,createdAt:new Date(Date.parse(date)+index*1000).toISOString()}));
    const env=await connectedPage(engine,{initialHistory,viewport:{width:390,height:844}}),{page}=env;
    try{
      await page.locator('[data-message-id="resize-race-history-39"]').waitFor();
      await page.waitForFunction(()=>{const node=document.querySelector('#messages');return node&&node.scrollHeight-node.clientHeight>700&&node.scrollHeight-node.clientHeight-node.scrollTop<=2;});
      await settle(page);const jump=page.getByRole('button',{name:'Jump to latest message',exact:true});assert.equal(await jump.isVisible(),false,'login follows the bottom before the resize race');
      // Do not split this callback or await between resize and scroll: the
      // native ResizeObserver must not get a turn before explicit user intent.
      const changed=await page.evaluate(()=>{
        const node=document.querySelector('#messages'),height=node.clientHeight,oldStyle=node.getAttribute('style');
        node.style.flex='none';node.style.height=`${height-40}px`;
        const resizedHeight=node.clientHeight; // Flush geometry before scroll.
        node.scrollTop=250;node.dispatchEvent(new Event('scroll'));
        return{height,resizedHeight,oldStyle,topAfterEvent:node.scrollTop,total:node.scrollHeight};
      });
      assert.ok(changed.resizedHeight>0&&changed.resizedHeight<changed.height,'test actually reduces scroll-container geometry');assert.ok(changed.total-changed.resizedHeight>700,'250 is an unclamped older-history position');
      assert.equal(changed.topAfterEvent,250,'the same synchronous scroll event respects upward intent instead of writing bottom');
      await jump.waitFor({state:'visible'});await settle(page);assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),250,'queued ResizeObserver follow writes cannot pull a reader down');
      await page.locator('#messages').evaluate((node,oldStyle)=>{if(oldStyle===null)node.removeAttribute('style');else node.setAttribute('style',oldStyle);},changed.oldStyle);
      await settle(page);assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),250,'restoring review layout retains the reading position');assert.equal(await jump.isVisible(),true);
      await jump.click();await page.waitForFunction(()=>{const node=document.querySelector('#messages');return node.scrollHeight-node.clientHeight-node.scrollTop<=2;});await jump.waitFor({state:'hidden'});await settle(page);
      assert.ok(await page.locator('#messages').evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop<=2),'explicit Jump still restores bottom-following');
      assert.equal(env.fixture.state.runs.get(BOT_A).length,0);assert.equal(env.traffic.filter(call=>call.method==='POST'&&/\/(messages|audio-messages|continue|runs|dictations)(?:\/|$)/.test(call.path)).length,0,'scroll regression does not admit or transcribe work');
    }catch(error){await env.recordFailure(error);throw error;}finally{await env.close();}
  });
  scenario('task composer uses isolated dictation routes and fences task-to-task navigation',async()=>{
    const env=await connectedPage(engine,{tasks:true}),mock=await installDictationMocks(env.page),{page}=env;
    try{
      await draft(page).fill('ordinary bot draft');await openTask(page);await draft(page).fill('task draft');await selectRange(page,10);await beginPcm(page);await stopForTranscription(page,mock);await expectDraft(page,`task draft ${transcript}`);assertWavUpload(mock,`/v1/tasks/${TASK_A}`);assertNoAdmission(env,mock);
      const pending=await installDictationMocks(page,{hold:true});
      try{
        await selectRange(page,(await draft(page).inputValue()).length);await beginPcm(page);await stopForTranscription(page,pending);await pending.waitSubmitted();await openTask(page,TASK_B);await draft(page).fill('sibling task draft');await page.waitForFunction(()=>window.__dictationAborts>0);
        pending.release();await pending.waitHandled();await settle(page);await expectDraft(page,'sibling task draft');assert.equal(pending.calls.posts[0].path,`/v1/tasks/${TASK_A}/dictations`);assertNoAdmission(env,pending);await returnToBots(page);await expectDraft(page,'ordinary bot draft');assert.equal(await page.locator('.timber-audio-message').count(),0);
      }finally{pending.release();}
    }catch(error){await env.recordFailure(error);throw error;}finally{mock.release();await env.close();}
  });
}
