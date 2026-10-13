import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {createConsoleFixture,BOT_A,TEST_TOKEN} from './console-fixture.mjs';

// Render the actual production bundle. All identity, audio and API data is local
// fixture data; never permits external traffic or paid transcription.
const TASK='10000000-0000-4000-8000-000000000091',date='2026-10-05T10:00:00.000Z';
const browsers=new Map();
after(async()=>{for(const browser of browsers.values())await(await browser).close();});
function browserFor(engine){if(!browsers.has(engine))browsers.set(engine,(engine==='chromium'?chromium:webkit).launch({headless:!process.env.COMPACT_VOICE_VISUAL,...(engine==='chromium'&&process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(engine==='webkit'&&process.env.CONSOLE_WEBKIT_PATH?{executablePath:process.env.CONSOLE_WEBKIT_PATH}:{}),...(engine==='chromium'&&process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})}));return browsers.get(engine);}
function fakeMic(){
  window.__micCalls=0;window.__trackStops=0;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micCalls++;return{getTracks:()=>[{stop(){window.__trackStops++;}}]};}}});
  window.MediaRecorder=class{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm;codecs=opus';start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};
}
const json=(route,value)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
async function installTask(page,served=[]){
  const task={id:TASK,title:'Compact voice fixture',description:'No inference',botId:BOT_A,botName:'Ada',status:'queued',createdAt:date};
  await page.route('**/v1/tasks**',route=>{
    const path=new URL(route.request().url()).pathname;served.push(path);
    assert.equal(route.request().method(),'GET','layout fixture must not admit task work');
    if(path==='/v1/tasks')return json(route,{tasks:[task]});
    const tail=path.slice(`/v1/tasks/${TASK}`.length);
    const result=tail===''?{task}:tail==='/messages'?{messages:[],nextCursor:null}:tail==='/runs'?{runs:[],activeRuns:[],nextCursor:null}:tail==='/approvals'?{approvals:[]}:tail==='/agents'?{agents:[],delegations:[]}:tail==='/connections'?{connections:[]}:tail==='/keychain'?{entries:[],requests:[]}:tail==='/computer'?{computer:{id:`task:${TASK}`,state:'stopped',provider:'cloudflare'}}:tail==='/context'?{context:{automatic:true,estimatedTokens:0,activeEntries:0,contextWindow:200000,compactions:[]}}:{events:[],nextCursor:null};
    if(tail==='/events'&&!new URL(route.request().url()).searchParams.has('format'))return route.fulfill({status:200,contentType:'text/event-stream',body:''});
    return json(route,result);
  });
}
async function capture(page,label){
  const directory=process.env.CONSOLE_SCREENSHOT_DIR||'/tmp/timber-compact-voice-screenshots';await mkdir(directory,{recursive:true});
  await page.screenshot({path:`${directory}/${label}.png`});
  if(process.env.COMPACT_VOICE_VISUAL){
    await writeFile('/tmp/timber-compact-visual-state.json',JSON.stringify({label,url:page.url(),capturedAt:new Date().toISOString()}));
    // Operator inspects the real headed page before acknowledging this stage.
    while(await readFile('/tmp/timber-compact-visual-ack','utf8').catch(()=>'')!==label)await new Promise(resolve=>setTimeout(resolve,100));
  }
}
for(const engine of ['chromium','webkit'])for(const surface of ['bot','task'])for(const width of [320,390,1280])test(`${engine} ${surface} ${width}: compact voice actions preserve the composer and Add menu`,{skip:engine==='webkit'&&!existsSync(process.env.CONSOLE_WEBKIT_PATH||webkit.executablePath())?'WebKit executable unavailable; CI Chromium is not physical Safari/iPhone coverage':false},async()=>{
  const fixture=await createConsoleFixture(),browser=await browserFor(engine),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:width===1280?800:844}}),external=[],errors=[],traffic=[],taskRequests=[],servedTasks=[];
  await context.addInitScript(fakeMic);const page=await context.newPage();page.setDefaultTimeout(6000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/v1/tasks'))taskRequests.push(new URL(request.url()).pathname);if(request.method()!=='GET'&&new URL(request.url()).pathname!=='/v1/session')traffic.push({method:request.method(),path:new URL(request.url()).pathname});});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(fixture.url).origin)return route.fallback();external.push(url.origin);return route.abort('blockedbyclient');});
  await installTask(page,servedTasks);
  try{
    await page.goto(surface==='task'?`${fixture.url}#tasks`:fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();
    if(surface==='task'){await page.getByRole('region',{name:'Global tasks'}).waitFor();await page.locator(`[data-task-id="${TASK}"].timber-tasks-card`).click();await page.locator(`.timber-tasks-detail[data-task-id="${TASK}"] #message`).waitFor();}
    else {if(width<=760)await page.locator(`#bot-list button[data-bot-id="${BOT_A}"]`).click();await page.locator('#message:visible').waitFor();}
    const composer=page.locator('.timber-composer:visible'),mic=composer.getByRole('button',{name:'Record audio',exact:true}),draft=page.locator('#message:visible');
    if(surface==='task'){assert.equal(await mic.count(),0,'tasks do not advertise an unsupported audio-message endpoint');assert.equal(await composer.getByRole('button',{name:'Dictate text',exact:true}).count(),0);return;}
    await mic.waitFor();assert.equal(await composer.locator('.timber-audio-tools,.timber-audio-note').count(),0,'no idle voice row or permanent format disclaimer');
    assert.doesNotMatch(await composer.innerText(),/WAV, MP3|M4A\/MP4|Audio file|billed separately|billing is separate|10 minutes/i,'format/billing help is contextual, not permanent composer copy');
    assert.equal(await composer.getByRole('button',{name:'Record audio',exact:true}).count(),1,'one primary microphone');
    assert.equal(await page.evaluate(()=>window.__micCalls),0,'opening a composer never requests microphone permission');
    assert.equal(await draft.evaluate(node=>document.activeElement===node),false,'opening never autofocuses the draft');
    const geometry=await composer.evaluate(node=>{const row=node.querySelector('.timber-composer-row'),buttons=['Add','Record audio','Send message'].map(label=>row.querySelector(`[aria-label="${label}"]`)),box=element=>element.getBoundingClientRect().toJSON();return{composer:box(node),row:box(row),buttons:buttons.map(box),scroll:document.documentElement.scrollWidth,viewport:innerWidth};});
    assert.equal(geometry.scroll,geometry.viewport,'no page horizontal overflow');assert.ok(geometry.composer.height<=90,`idle composer remains compact (${geometry.composer.height}px)`);
    for(const [index,button] of geometry.buttons.entries()){assert.ok(button.x>=geometry.row.x&&button.right<=geometry.row.right+1,'voice actions stay within existing row');if(width<600){assert.ok(button.width>=44&&button.height>=44,'44px mobile action targets');}if(index)assert.ok(button.x>=geometry.buttons[index-1].right-1,'order remains Add, microphone, Send');}
    assert.ok(await mic.getAttribute('title'),'microphone has contextual tooltip');
    await capture(page,`${engine}-${surface}-${width}-idle`);
    await draft.fill('Keep this draft');await composer.getByRole('button',{name:'Add',exact:true}).click();
    for(const name of (surface==='bot'?['Secure input','Attach images','Attach audio']:['Secure input','Attach images']))await page.getByRole('menuitem',{name,exact:true}).waitFor();
    const menu=await page.getByRole('menu').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width+1,'Add menu remains within viewport');
    if(width===390)await capture(page,`${engine}-${surface}-${width}-menu`);
    await page.keyboard.press('Escape');assert.equal(await draft.inputValue(),'Keep this draft','opening Add preserves text');
    // Radix restores Add focus asynchronously on Escape. Finish that keyboard
    // interaction before explicitly focusing the next action; no sleep/retry.
    await page.waitForFunction(()=>!document.querySelector('[role=menu]')&&document.activeElement?.getAttribute('aria-label')==='Add');
    await draft.fill('');await mic.focus();await page.keyboard.press('Enter');await composer.getByRole('button',{name:'Stop recording',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__micCalls),1,'keyboard activation requests microphone exactly once');assert.equal(await draft.isDisabled(),true,'audio capture locks the standalone input');
    assert.equal(await composer.locator('.timber-audio-tools').count(),0,'active dictation does not restore the rejected toolbar');
    if(width===390)await capture(page,`${engine}-${surface}-${width}-recording`);
    await composer.getByRole('button',{name:'Discard',exact:true}).click();await mic.waitFor();assert.equal(await page.evaluate(()=>window.__trackStops),1,'Cancel releases microphone');assert.equal(await draft.inputValue(),'');
    assert.equal(await page.getByRole('dialog').count(),0,'dictation cancellation has no mode/confirmation modal');
    assert.deepEqual(traffic,[],'layout and cancelled capture never uploads, transcribes or sends');assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);
  }catch(error){
    error.message+=`\nLayout fixture diagnostics: ${JSON.stringify({taskRequests,servedTasks,errors,controller:await page.evaluate(()=>navigator.serviceWorker?.controller?.scriptURL||null),tasks:await page.getByRole('region',{name:'Global tasks'}).allTextContents()})}`;
    console.error(error.message);throw error;
  }finally{await context.close();await fixture.close();}
});
