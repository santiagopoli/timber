import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';

let browser;
after(async()=>{await browser?.close();});
const initialEntry=(overrides={})=>({id:'memory-concise',category:'preference',title:'Response style',content:'Use concise answers.',pinned:true,state:'active',revision:1,actor:'review',sources:[{kind:'conversation',messageId:'message-one',role:'user',quote:'Please keep answers concise.',createdAt:'2026-10-05T10:00:00Z'}],createdAt:'2026-10-05T10:00:00Z',updatedAt:'2026-10-05T10:00:00Z',...overrides});
const initialMemory=(entries=[initialEntry()])=>({schemaVersion:2,entries,suggestions:[],revision:1,limits:{maxEntries:200,maxEntryCharacters:1200,maxTitleCharacters:100,contextCharacters:16000},review:{status:'idle',examinedMessages:0,added:0,suggested:0},content:'Use concise answers.',maxCharacters:16000});
async function withPage(work,width=1440) {
  browser??=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],csp=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
  await page.exposeFunction('__memoryCsp',value=>csp.push(value));await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>globalThis.__memoryCsp(event.effectiveDirective)));
  const memory=initialMemory();fixture.state.memories.set(BOT_A,memory);fixture.state.memoryHistories.set(`${BOT_A}:memory-concise`,[{entry:structuredClone(memory.entries[0]),operation:'create',at:memory.entries[0].createdAt}]);
  const open=async()=>{await page.getByRole('button',{name:'Context and memory',exact:true}).click();await page.getByRole('region',{name:'Durable memory'}).waitFor();};
  const login=async()=>{await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});if(width<=760)await page.locator('.bot-item').first().click();await open();};
  try{await work({...fixture,page,context,login,open,memory});assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);assert.deepEqual(fixture.state.failures,[]);assert.ok(fixture.state.requestAuth.filter(call=>call.path.includes('/memory')).every(call=>call.hasCookie&&call.client==='console'&&!call.hasBearer),'memory uses authenticated console requests');}
  finally{await context.close();await fixture.close();}
}
const dialog=page=>page.getByRole('dialog',{name:'Context and memory'});
const close=page=>dialog(page).getByRole('button',{name:'Close context and memory',exact:true}).click();
const note=(page,id='memory-concise')=>dialog(page).locator(`[data-memory-entry="${id}"]`);
const saved=page=>dialog(page).getByRole('status').filter({hasText:'Memory saved.'}).waitFor();

for(const width of [1440,390])test(`memory CRUD, provenance, search and compaction preserve history at ${width}px`,async()=>{
  await withPage(async({page,login,memory,state})=>{
    await login();const d=dialog(page);await note(page).locator('summary').filter({hasText:'Source & history'}).click();assert.match(await note(page).innerText(),/Learned from conversation/);assert.match(await note(page).innerText(),/Your message/);assert.match(await note(page).innerText(),/Please keep answers concise/);
    await note(page).getByRole('button',{name:'View revisions',exact:true}).click();await note(page).locator('.timber-memory-revisions').waitFor();assert.match(await note(page).innerText(),/Revision 1 · create/);
    await d.getByRole('button',{name:'Add memory',exact:true}).click();await d.getByLabel('Memory category').selectOption('decision');await d.getByLabel('Memory title').fill('Repository workflow');await d.getByLabel('Memory note').fill('Deploy validated changes directly to main.');await d.getByRole('button',{name:'Save memory',exact:true}).click();await saved(page);
    const added=memory.entries.find(entry=>entry.title==='Repository workflow');assert.ok(added);assert.equal(added.category,'decision');assert.equal(added.actor,'user');assert.deepEqual(added.sources,[{kind:'user'}]);
    await d.getByLabel('Search memory').fill('validated');await note(page,added.id).waitFor();await note(page).waitFor({state:'detached'});assert.ok(state.calls.some(call=>call.path.includes('/memory/search?q=validated')));
    await d.getByLabel('Search memory').fill('');await note(page).waitFor();await note(page,added.id).getByRole('button',{name:'Edit',exact:true}).click();await d.getByLabel('Memory note').fill('Run checks before deploying to main.');await d.getByRole('button',{name:'Save memory',exact:true}).click();await saved(page);assert.equal(memory.entries.find(entry=>entry.id===added.id).revision,2);
    await note(page,added.id).getByRole('button',{name:'Forget',exact:true}).click();await note(page,added.id).waitFor({state:'detached'});assert.equal(memory.entries.length,1);assert.equal(state.memoryHistories.get(`${BOT_A}:${added.id}`)[0].operation,'forget');
    const historySnapshot=()=>page.locator('#messages [data-message-id]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-message-id'),text:node.querySelector('.timber-message-content')?.textContent})));
    const historyBefore=await historySnapshot();await d.locator('.timber-memory-context summary').click();await d.getByRole('button',{name:'Compact now',exact:true}).click();await d.locator('[data-compaction-status="completed"]').waitFor();assert.deepEqual(await historySnapshot(),historyBefore,'Compaction retains visible message content and identity.');assert.match(await d.innerText(),/Full history retained/);
    const geometry=await d.boundingBox();assert.ok(geometry.x>=0&&geometry.x+geometry.width<=width);assert.equal(await d.evaluate(node=>node.scrollWidth<=node.clientWidth),true,'dialog has no horizontal overflow');
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/context-memory-${width}.png`,animations:'disabled'});}
  },width);
});

test('memory conflicts and refresh retain a draft until the latest revision is explicitly adopted',async()=>{
  await withPage(async({page,login,memory,state})=>{
    await login();const d=dialog(page);await note(page).getByRole('button',{name:'Edit',exact:true}).click();await d.getByLabel('Memory note').fill('Keep this unsaved correction.');memory.entries[0].revision=2;memory.entries[0].content='A different saved correction.';memory.revision++;
    await d.getByRole('button',{name:'Save memory',exact:true}).click();await d.getByRole('alert').filter({hasText:'This memory changed'}).waitFor();assert.equal(await d.getByLabel('Memory note').inputValue(),'Keep this unsaved correction.');assert.ok(await d.getByRole('button',{name:'Save memory',exact:true}).isDisabled());
    await d.getByRole('button',{name:'Refresh memory',exact:true}).click();assert.equal(await d.getByLabel('Memory note').inputValue(),'Keep this unsaved correction.');await d.getByText('Latest saved note: A different saved correction.',{exact:true}).waitFor();
    await close(page);await page.getByRole('button',{name:'Context and memory',exact:true}).click();assert.equal(await d.getByLabel('Memory note').inputValue(),'Keep this unsaved correction.');
    await d.getByRole('button',{name:'Use latest revision, keep my draft',exact:true}).click();await d.getByRole('button',{name:'Save memory',exact:true}).click();await saved(page);assert.equal(memory.entries[0].content,'Keep this unsaved correction.');
    assert.deepEqual(state.calls.filter(call=>call.method==='PATCH'&&call.path.includes('/memory/')).map(call=>call.body.expectedRevision),[1,2]);
  });
});

test('unconfirmed memory writes retry identical payload and operation without adding duplicate notes',async()=>{
  await withPage(async({page,login,memory,state})=>{
    await login();const d=dialog(page);await d.getByRole('button',{name:'Add memory',exact:true}).click();await d.getByLabel('Memory title').fill('Lost response');await d.getByLabel('Memory note').fill('This note must be saved once.');state.memoryRepliesToLose=1;
    await d.getByRole('button',{name:'Save memory',exact:true}).click();await d.getByRole('button',{name:'Retry request',exact:true}).waitFor();assert.equal(memory.entries.filter(entry=>entry.title==='Lost response').length,1);assert.ok(await d.getByLabel('Memory note').isDisabled());
    await close(page);await page.getByRole('button',{name:'Context and memory',exact:true}).click();await d.getByRole('button',{name:'Retry request',exact:true}).click();await saved(page);
    const attempts=state.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/memory/entries'));assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);assert.equal(memory.entries.filter(entry=>entry.title==='Lost response').length,1);
  });
});

test('suggestions show exact speaker sources and can be corrected, accepted or discarded; legacy is archived',async()=>{
  await withPage(async({page,login,memory,state,context})=>{
    memory.suggestions=[initialEntry({id:'suggestion-one',state:'suggested',title:'New response style',content:'Always write very long essays.',pinned:false,replacesId:'memory-concise',replacesRevision:1,sources:[{kind:'conversation',role:'assistant',quote:'I could write an essay.'}]}),initialEntry({id:'suggestion-two',state:'suggested',title:'Unhelpful suggestion',pinned:false})];memory.legacy={content:'legacy scratchpad 𝑥 000???\nraw old context',revision:9,importedAt:'2026-10-05T10:00:00Z'};
    await login();const d=dialog(page),suggestion=note(page,'suggestion-one');await suggestion.locator('summary').filter({hasText:'Source & history'}).click();assert.match(await suggestion.innerText(),/Assistant message/);assert.match(await suggestion.innerText(),/I could write an essay/);assert.equal(await d.locator('.timber-memory-legacy pre').isVisible(),false);
    await suggestion.getByRole('button',{name:'Correct',exact:true}).click();await d.getByLabel('Memory note').fill('Keep answers concise unless I ask for detail.');await d.getByRole('button',{name:'Save memory',exact:true}).click();await saved(page);assert.equal(memory.suggestions[1].state,'suggested');assert.equal(memory.entries[0].content,'Use concise answers.');
    await note(page,'suggestion-one').getByRole('button',{name:'Accept',exact:true}).click();await d.getByRole('status').filter({hasText:'Suggestion accepted.'}).waitFor();assert.equal(memory.entries.length,1);assert.equal(memory.entries[0].content,'Keep answers concise unless I ask for detail.');assert.doesNotMatch(await note(page,'suggestion-one').innerText(),/The original note changed/);assert.ok(state.calls.some(call=>call.path.endsWith('/suggestion-one/accept')&&call.body.replacesRevision===1));
    await note(page,'suggestion-two').getByRole('button',{name:'Discard',exact:true}).click();await note(page,'suggestion-two').waitFor({state:'detached'});assert.equal(memory.suggestions.length,0);
    await d.locator('.timber-memory-legacy summary').click();assert.match(await d.locator('.timber-memory-legacy').innerText(),/not used as active memory/);const [download]=await Promise.all([page.waitForEvent('download'),d.getByRole('link',{name:'Export previous memory'}).click()]);assert.equal(download.suggestedFilename(),`timber-memory-${BOT_A}.txt`);await download.delete();assert.equal(memory.legacy.content,'legacy scratchpad 𝑥 000???\nraw old context');
  });
});

test('memory review exposes progress, failure and continuation; bot switch cannot carry a draft to another bot',async()=>{
  await withPage(async({page,login,memory,state,open})=>{
    memory.review={status:'failed',examinedMessages:12,added:1,suggested:0,error:'History review provider unavailable.',hasMore:true};state.memories.set(BOT_B,initialMemory([]));
    await login();const d=dialog(page);await d.getByRole('alert').filter({hasText:'History review provider unavailable.'}).waitFor();await d.getByRole('button',{name:'Review more history',exact:true}).click();await d.locator('[data-memory-review-status="completed"]').waitFor();assert.ok(state.calls.some(call=>call.path.endsWith('/memory/review')&&call.body.operationId));
    await note(page).getByRole('button',{name:'Edit',exact:true}).click();await d.getByLabel('Memory note').fill('Private Ada draft');await close(page);await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_B}"]`).click();await open();await d.getByText('No memories yet. Add a note or review past messages.',{exact:true}).waitFor();assert.equal(await d.getByLabel('Memory note').count(),0);assert.doesNotMatch(await d.innerText(),/Private Ada draft|Response style/);
    await d.getByRole('button',{name:'Add memory',exact:true}).click();await d.getByLabel('Memory title').fill('Linus note');await d.getByLabel('Memory note').fill('Belongs only to Linus.');await d.getByRole('button',{name:'Save memory',exact:true}).click();await saved(page);assert.equal(state.memories.get(BOT_B).entries[0].content,'Belongs only to Linus.');assert.equal(memory.entries[0].content,'Use concise answers.');
  },390);
});

test('a correction cannot replace a note that changed since the suggestion was made',async()=>{
  await withPage(async({page,login,memory,state})=>{
    memory.suggestions=[initialEntry({id:'stale-correction',state:'suggested',title:'Old correction',replacesId:'memory-concise',replacesRevision:1})];memory.entries[0].revision=2;memory.entries[0].content='The newer preference.';
    await login();const suggestion=note(page,'stale-correction');await suggestion.getByText('The original note changed. Edit the active note or discard this suggestion.',{exact:true}).waitFor();assert.ok(await suggestion.getByRole('button',{name:'Accept',exact:true}).isDisabled());await suggestion.locator('.timber-memory-replacement summary').click();assert.match(await suggestion.locator('.timber-memory-replacement').innerText(),/The newer preference/);assert.equal(state.calls.filter(call=>call.path.endsWith('/stale-correction/accept')).length,0);
  });
});

test('history review refreshes while running and preserves an open memory draft',async()=>{
  await withPage(async({page,login,memory})=>{
    memory.review={status:'running',operationId:'review-batch',examinedMessages:0,added:0,suggested:0};await login();const d=dialog(page);assert.ok(await d.getByRole('button',{name:'Reviewing…',exact:true}).isDisabled());await note(page).getByRole('button',{name:'Edit',exact:true}).click();await d.getByLabel('Memory note').fill('Keep editing during review.');memory.review={status:'completed',operationId:'review-batch',examinedMessages:40,added:2,suggested:1,hasMore:true};await d.locator('[data-memory-review-status="completed"]').waitFor();assert.match(await d.innerText(),/40 messages reviewed · 2 notes added · 1 suggestions/);assert.equal(await d.getByLabel('Memory note').inputValue(),'Keep editing during review.');await d.getByRole('button',{name:'Review more history',exact:true}).waitFor();
  });
});

test('signing out clears memory drafts before another session starts',async()=>{
  await withPage(async({page,login,open,memory})=>{
    await login();await note(page).getByRole('button',{name:'Edit',exact:true}).click();await dialog(page).getByLabel('Memory note').fill('Unsaved session-only draft.');await close(page);await page.locator('#settings-button').click();await page.locator('#disconnect').click();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.getByRole('dialog',{name:'Context and memory'}).count(),0);
    await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});await open();assert.equal(await dialog(page).getByLabel('Memory note').count(),0);assert.doesNotMatch(await dialog(page).innerText(),/Unsaved session-only draft/);assert.equal(memory.entries[0].content,'Use concise answers.');
  });
});

test('manual compaction retries an unconfirmed receipt with the same operation identity',async()=>{
  await withPage(async({page,login})=>{
    const submissions=[];
    await page.route(`**/v1/bots/${BOT_A}/context/compact`,async route=>{submissions.push(route.request().postDataJSON());if(submissions.length===1)return route.abort('failed');return route.continue();});
    await login();const d=dialog(page);await d.locator('.timber-memory-context summary').click();await d.getByRole('button',{name:'Compact now',exact:true}).click();await d.getByRole('alert').waitFor();await d.getByRole('button',{name:'Compact now',exact:true}).click();await d.locator('[data-compaction-status="completed"]').waitFor();assert.equal(submissions.length,2);assert.equal(submissions[0].operationId,submissions[1].operationId);
  });
});

// These two new routes are isolated here until the shared console fixture adopts them.
async function memoryEnhancements(page,state,{preview}={}) {
  const restoreRequests=[],previewRequests=[],receipts=new Map(),control={restoreRepliesToLose:0,beforeRestore:undefined,beforeRestoreReply:undefined};
  await page.route('**/v1/bots/*/memory/context?*',async route=>{
    const url=new URL(route.request().url()),botId=url.pathname.split('/')[3],query=url.searchParams.get('q')||'';
    previewRequests.push({botId,query});
    const notes=state.memories.get(botId)?.entries||[],text=notes.map(entry=>`${entry.title}: ${entry.content}`).join('\n');
    const context=preview?await preview({botId,query}):{text,usedCharacters:text.length,maxCharacters:8000,selected:notes.map(entry=>({id:entry.id,scope:'root',title:entry.title})),omittedCount:0};
    await route.fulfill({json:{context}});
  });
  await page.route('**/v1/bots/*/memory/entries/*/restore',async route=>{
    const url=new URL(route.request().url()),parts=url.pathname.split('/'),botId=parts[3],entryId=parts[6],body=route.request().postDataJSON();
    restoreRequests.push({botId,entryId,body});
    const key=`${botId}:${body.operationId}`,previous=receipts.get(key);
    if(previous){assert.deepEqual(previous.body,body,'a replay must retain the original restore payload');return route.fulfill({json:previous.payload});}
    if(control.beforeRestore)await control.beforeRestore();
    const memory=state.memories.get(botId),history=state.memoryHistories.get(`${botId}:${entryId}`)||[],entry=memory?.entries.concat(memory.suggestions).find(item=>item.id===entryId)||history[0]?.entry;
    if(!entry||entry.revision!==body.expectedRevision)return route.fulfill({status:409,json:{error:{code:'memory_conflict',message:'This memory changed. Review the latest revision before restoring.'}}});
    const source=history.find(item=>item.entry.revision===body.revision)?.entry;
    assert.ok(source&&['active','forgotten','suggested'].includes(source.state),'restoration requires an eligible saved revision');
    const restored={...source,state:source.state==='suggested'?'suggested':'active',actor:'user',sources:source.state==='suggested'?source.sources:[{kind:'user'}],revision:entry.revision+1,updatedAt:new Date().toISOString()};
    if(restored.state==='suggested'&&entry.state==='active'&&entry.replacesId){
      // Mock the atomic restore response: the former note is active again and
      // the correction points to its new revision, still pending acceptance.
      const original=state.memoryHistories.get(`${botId}:${entry.replacesId}`)?.find(item=>item.entry.state==='active')?.entry;
      assert.ok(original);const previous={...original,revision:original.revision+2};memory.entries.push(previous);restored.replacesRevision=previous.revision;
    }
    memory.entries=memory.entries.filter(item=>item.id!==entryId);memory.suggestions=memory.suggestions.filter(item=>item.id!==entryId);
    (restored.state==='suggested'?memory.suggestions:memory.entries).push(restored);memory.revision++;
    history.unshift({entry:structuredClone(restored),operation:'restore',at:restored.updatedAt});
    const payload={result:{entry:restored,changed:true}};receipts.set(key,{body,payload});
    if(control.beforeRestoreReply)await control.beforeRestoreReply();
    if(control.restoreRepliesToLose>0){control.restoreRepliesToLose--;return route.fulfill({contentType:'application/json',body:'{"result":'});}
    await route.fulfill({json:payload});
  });
  return {restoreRequests,previewRequests,control};
}
const showRevisions=async(page,id)=>{await note(page,id).locator('summary').filter({hasText:'Source & history'}).click();await note(page,id).getByRole('button',{name:'View revisions',exact:true}).click();await note(page,id).locator('.timber-memory-revisions').waitFor();};
const revision=(page,number)=>note(page).locator(`[data-memory-revision="${number}"]`);
const previewPanel=page=>dialog(page).locator('.timber-memory-preview');

for(const width of [1440,390])test(`memory preview shows the separate character budget and selected notes at ${width}px`,async()=>{
  await withPage(async({page,login,memory,state})=>{
    memory.entries.push(initialEntry({id:'release-workflow',title:'Release workflow',content:'Check deployments before sharing links.'}),initialEntry({id:'omitted-note',title:'Travel preferences',content:'A note outside this selection.'}));
    const {previewRequests}=await memoryEnhancements(page,state,{preview:async({query})=>({text:query?'Release workflow: Check deployments before sharing links.':'Response style: Use concise answers.\nRelease workflow: Check deployments before sharing links.',usedCharacters:query?56:7990,maxCharacters:8000,selected:memory.entries.slice(query?1:0,2).map(entry=>({id:entry.id,scope:'root',title:entry.title})),omittedCount:query?2:1})});
    await login();assert.equal(previewRequests.length,0,'collapsed memory preview performs no selection request');
    await previewPanel(page).locator('summary').first().click();const meter=previewPanel(page).getByRole('meter',{name:'Memory character budget'});await meter.waitFor();
    assert.equal(await meter.getAttribute('max'),'8000');assert.equal(await meter.getAttribute('value'),'7990');assert.match(await previewPanel(page).innerText(),/7,990 \/ 8,000 characters/);assert.match(await dialog(page).locator('.timber-memory-context').innerText(),/42,000 tokens/);
    assert.deepEqual(await previewPanel(page).getByRole('list',{name:'Selected memories'}).locator('li span').allTextContents(),['Response style','Release workflow']);assert.match(await previewPanel(page).innerText(),/1 other note is outside this selection/);
    await previewPanel(page).getByText('Read selected memory',{exact:true}).click();assert.doesNotMatch(await previewPanel(page).locator('pre').innerText(),/Travel preferences|outside this selection/);
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/memory-preview-${width}.png`,animations:'disabled'});}
    await note(page).getByRole('button',{name:'Edit',exact:true}).click();await dialog(page).getByLabel('Memory note').fill('An unsaved note stays here.');
    await previewPanel(page).getByLabel('Task to preview',{exact:true}).fill('ship a release');await page.waitForFunction(()=>document.querySelector('[aria-label="Memory character budget"]')?.getAttribute('value')==='56');
    assert.deepEqual(await previewPanel(page).getByRole('list',{name:'Selected memories'}).locator('li span').allTextContents(),['Release workflow']);assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'An unsaved note stays here.');assert.equal(previewRequests.at(-1).query,'ship a release');
    assert.equal(await dialog(page).evaluate(element=>element.scrollWidth<=element.clientWidth),true,'preview remains within the mobile dialog');
  },width);
});

test('restoring historical active or forgotten revisions creates a user revision without replacing a draft',async()=>{
  await withPage(async({page,login,memory,state})=>{
    const first=structuredClone(memory.entries[0]),forgotten={...first,state:'forgotten',revision:2},current={...first,revision:3,content:'Current saved preference.'};memory.entries=[current];memory.revision=3;
    state.memoryHistories.set(`${BOT_A}:${first.id}`,[{entry:current,operation:'restore',at:current.updatedAt},{entry:forgotten,operation:'forget',at:first.updatedAt},{entry:first,operation:'create',at:first.updatedAt}]);
    const {restoreRequests}=await memoryEnhancements(page,state);await login();await dialog(page).getByRole('button',{name:'Add memory',exact:true}).click();await dialog(page).getByLabel('Memory title').fill('Unfinished note');await dialog(page).getByLabel('Memory note').fill('Keep this draft through restoration.');await showRevisions(page);
    assert.equal(await revision(page,3).getByRole('button',{name:'Restore this revision',exact:true}).count(),0);assert.equal(await revision(page,2).getByRole('button',{name:'Restore this revision',exact:true}).count(),1);
    await revision(page,1).getByRole('button',{name:'Restore this revision',exact:true}).click();await dialog(page).getByRole('status').filter({hasText:'Note restored.'}).waitFor();await note(page).locator('.timber-memory-note-content').filter({hasText:'Use concise answers.'}).waitFor();
    assert.equal(memory.entries[0].revision,4);assert.equal(memory.entries[0].actor,'user');assert.deepEqual(memory.entries[0].sources,[{kind:'user'}]);assert.equal(restoreRequests[0].body.expectedRevision,3);assert.equal(restoreRequests[0].body.revision,1);assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'Keep this draft through restoration.');
    await showRevisions(page);await revision(page,2).getByRole('button',{name:'Restore this revision',exact:true}).click();await note(page).locator('.timber-memory-note-content').filter({hasText:'Use concise answers.'}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-memory-entry="memory-concise"]')?.textContent.includes('revision 5'));
    assert.equal(restoreRequests[1].body.expectedRevision,4);assert.equal(restoreRequests[1].body.revision,2);assert.equal(memory.entries[0].state,'active');assert.equal(await dialog(page).getByLabel('Memory title').inputValue(),'Unfinished note');
  });
});

test('a concurrent revision rejects restoration, refreshes the note and preserves the unsaved draft',async()=>{
  await withPage(async({page,login,memory,state})=>{
    const original=structuredClone(memory.entries[0]);memory.entries[0]={...original,revision:2,content:'Saved revision two.'};memory.revision=2;
    state.memoryHistories.get(`${BOT_A}:${original.id}`).unshift({entry:structuredClone(memory.entries[0]),operation:'update',at:original.updatedAt});
    const {restoreRequests,control}=await memoryEnhancements(page,state);await login();await note(page).getByRole('button',{name:'Edit',exact:true}).click();await dialog(page).getByLabel('Memory note').fill('My draft survives a restore conflict.');await showRevisions(page);
    control.beforeRestore=()=>{control.beforeRestore=undefined;memory.entries[0]={...original,revision:3,content:'A concurrent saved correction.'};memory.revision=3;state.memoryHistories.get(`${BOT_A}:${original.id}`).unshift({entry:structuredClone(memory.entries[0]),operation:'update',at:original.updatedAt});};
    await revision(page,1).getByRole('button',{name:'Restore this revision',exact:true}).click();await dialog(page).getByRole('alert').filter({hasText:'This memory changed.'}).waitFor();await note(page).getByText('A concurrent saved correction.',{exact:true}).waitFor();
    assert.equal(restoreRequests.length,1);assert.equal(restoreRequests[0].body.expectedRevision,2);assert.equal(memory.entries[0].revision,3);assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'My draft survives a restore conflict.');assert.equal(await dialog(page).getByRole('button',{name:'Retry request',exact:true}).count(),0);
    await dialog(page).getByRole('button',{name:'Refresh memory',exact:true}).click();await showRevisions(page);await revision(page,1).getByRole('button',{name:'Restore this revision',exact:true}).click();await dialog(page).getByRole('status').filter({hasText:'Note restored.'}).waitFor();
    assert.deepEqual(restoreRequests.map(item=>item.body.expectedRevision),[2,3]);assert.notEqual(restoreRequests[0].body.operationId,restoreRequests[1].body.operationId);assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'My draft survives a restore conflict.');
  });
});

test('Forget and Undo recover lost receipts with identical operation IDs and no extra revisions',async()=>{
  await withPage(async({page,login,memory,state})=>{
    const {restoreRequests,control}=await memoryEnhancements(page,state);await login();state.memoryRepliesToLose=1;
    await note(page).getByRole('button',{name:'Forget',exact:true}).click();await dialog(page).getByRole('button',{name:'Retry request',exact:true}).click();await dialog(page).getByRole('button',{name:'Undo',exact:true}).waitFor();assert.equal(memory.entries.length,0);
    const deletes=state.calls.filter(call=>call.method==='DELETE'&&call.path.endsWith('/memory/entries/memory-concise'));assert.equal(deletes.length,2);assert.deepEqual(deletes[0].body,deletes[1].body);
    control.restoreRepliesToLose=1;await dialog(page).getByRole('button',{name:'Undo',exact:true}).click();await dialog(page).getByRole('button',{name:'Retry request',exact:true}).waitFor();assert.equal(memory.entries[0].revision,3);
    await close(page);await page.getByRole('button',{name:'Context and memory',exact:true}).click();await dialog(page).getByRole('button',{name:'Retry request',exact:true}).click();await dialog(page).getByRole('status').filter({hasText:'Note restored.'}).waitFor();
    assert.equal(restoreRequests.length,2);assert.deepEqual(restoreRequests[0].body,restoreRequests[1].body);assert.equal(restoreRequests[0].body.expectedRevision,2);assert.equal(restoreRequests[0].body.revision,1);assert.equal(memory.entries[0].revision,3);assert.equal(state.memoryHistories.get(`${BOT_A}:memory-concise`).length,3);assert.equal(await dialog(page).getByRole('button',{name:'Undo',exact:true}).count(),0);
  });
});

test('slow memory previews and restore receipts cannot cross a bot switch',async()=>{
  await withPage(async({page,login,memory,state,open})=>{
    let releasePreview,previewStarted,releaseRestore,restoreStarted;const previewGate=new Promise(resolve=>{releasePreview=resolve;}),previewSeen=new Promise(resolve=>{previewStarted=resolve;}),restoreGate=new Promise(resolve=>{releaseRestore=resolve;}),restoreSeen=new Promise(resolve=>{restoreStarted=resolve;});
    const other=initialEntry({id:'linus-memory',title:'Linus private note',content:'Only for Linus.'});state.memories.set(BOT_B,initialMemory([other]));
    const {control}=await memoryEnhancements(page,state,{preview:async({botId})=>{const entry=botId===BOT_A?memory.entries[0]:other;if(botId===BOT_A){previewStarted();await previewGate;}return {text:entry.content,usedCharacters:entry.content.length,maxCharacters:8000,selected:[{id:entry.id,scope:'root',title:entry.title}],omittedCount:0};}});
    await login();await previewPanel(page).locator('summary').first().click();await previewSeen;await close(page);await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_B}"]`).click();await open();await previewPanel(page).locator('summary').first().click();await previewPanel(page).getByText('Linus private note',{exact:true}).waitFor();releasePreview();assert.doesNotMatch(await previewPanel(page).innerText(),/Response style/);
    await close(page);await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_A}"]`).click();await open();await note(page).getByRole('button',{name:'Forget',exact:true}).click();await dialog(page).getByRole('button',{name:'Undo',exact:true}).waitFor();
    control.beforeRestoreReply=async()=>{restoreStarted();await restoreGate;};await dialog(page).getByRole('button',{name:'Undo',exact:true}).click();await restoreSeen;await close(page);await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_B}"]`).click();await open();const receipt=page.waitForResponse(response=>response.url().endsWith('/memory/entries/memory-concise/restore'));releaseRestore();await receipt;await note(page,other.id).waitFor();await dialog(page).getByRole('button',{name:'Add memory',exact:true}).click();await dialog(page).getByLabel('Memory note').fill('A new Linus draft.');
    assert.doesNotMatch(await dialog(page).innerText(),/Note restored|Response style/);assert.equal(await dialog(page).getByRole('button',{name:'Undo',exact:true}).count(),0);assert.equal(state.memories.get(BOT_B).entries[0].revision,1);assert.equal(memory.entries[0].revision,3);
  },390);
});

for(const action of ['Accept','Discard'])test(`Undo ${action.toLowerCase()} returns a suggestion to review and retries lost receipts without promotion`,async()=>{
  await withPage(async({page,login,memory,state})=>{
    const suggestion=initialEntry({id:'reversible-suggestion',title:'Suggested response style',state:'suggested',content:'Use concise answers unless detail is requested.',pinned:false,replacesId:'memory-concise',replacesRevision:1});memory.suggestions=[suggestion];state.memoryHistories.set(`${BOT_A}:${suggestion.id}`,[{entry:structuredClone(suggestion),operation:'suggest',at:suggestion.createdAt}]);
    const {restoreRequests,control}=await memoryEnhancements(page,state);await login();await dialog(page).getByRole('button',{name:'Add memory',exact:true}).click();await dialog(page).getByLabel('Memory title').fill('Unsaved memory');await dialog(page).getByLabel('Memory note').fill('Keep my draft while undoing a suggestion.');state.memoryRepliesToLose=1;
    await note(page,suggestion.id).getByRole('button',{name:action,exact:true}).click();await dialog(page).getByRole('button',{name:'Retry request',exact:true}).click();await dialog(page).getByRole('button',{name:'Undo',exact:true}).waitFor();
    assert.equal(memory.suggestions.length,0);assert.equal(memory.entries.some(item=>item.id===suggestion.id),action==='Accept');
    const attempts=state.calls.filter(call=>action==='Accept'?call.path.endsWith(`/${suggestion.id}/accept`):call.method==='DELETE'&&call.path.endsWith(`/${suggestion.id}`));assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);
    control.restoreRepliesToLose=1;await dialog(page).getByRole('button',{name:'Undo',exact:true}).click();await dialog(page).getByRole('button',{name:'Retry request',exact:true}).click();await dialog(page).getByRole('status').filter({hasText:'Suggestion restored.'}).waitFor();await note(page,suggestion.id).getByRole('button',{name:'Accept',exact:true}).waitFor();
    assert.equal(memory.entries.some(item=>item.id===suggestion.id),false);assert.equal(memory.suggestions.length,1);assert.equal(memory.suggestions[0].revision,3);assert.equal(memory.suggestions[0].state,'suggested');assert.deepEqual(memory.suggestions[0].sources,suggestion.sources);assert.equal(memory.entries.find(item=>item.id==='memory-concise').content,'Use concise answers.');assert.equal(await note(page,suggestion.id).getByRole('button',{name:'Accept',exact:true}).isDisabled(),false);
    assert.equal(restoreRequests.length,2);assert.deepEqual(restoreRequests[0].body,restoreRequests[1].body);assert.equal(restoreRequests[0].body.expectedRevision,2);assert.equal(restoreRequests[0].body.revision,1);assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'Keep my draft while undoing a suggestion.');
    await showRevisions(page,suggestion.id);await note(page,suggestion.id).locator('[data-memory-revision="1"]').getByRole('button',{name:'Restore suggestion',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-memory-entry="reversible-suggestion"]')?.textContent.includes('revision 4'));
    assert.equal(restoreRequests[2].body.expectedRevision,3);assert.equal(restoreRequests[2].body.revision,1);assert.equal(memory.suggestions[0].state,'suggested');assert.equal(await dialog(page).getByLabel('Memory note').inputValue(),'Keep my draft while undoing a suggestion.');
  },action==='Discard'?390:1440);
});

test('history offers Restore suggestion after acceptance but not after a later edit',async()=>{
  await withPage(async({page,login,memory,state})=>{
    const suggested=initialEntry({id:'history-suggestion',state:'suggested',title:'A past suggestion',content:'The suggested preference.'}),accepted={...suggested,state:'active',revision:2},edited={...accepted,id:'edited-suggestion',revision:3,title:'An edited accepted note',content:'A later deliberate edit.'};memory.entries=[accepted,edited];memory.revision=3;
    state.memoryHistories.set(`${BOT_A}:${accepted.id}`,[{entry:accepted,operation:'accept',at:accepted.updatedAt},{entry:suggested,operation:'suggest',at:suggested.updatedAt}]);state.memoryHistories.set(`${BOT_A}:${edited.id}`,[{entry:edited,operation:'update',at:edited.updatedAt},{entry:{...accepted,id:edited.id},operation:'accept',at:edited.updatedAt},{entry:{...suggested,id:edited.id},operation:'suggest',at:edited.updatedAt}]);
    const {restoreRequests}=await memoryEnhancements(page,state);await login();await showRevisions(page,edited.id);assert.equal(await note(page,edited.id).getByRole('button',{name:'Restore suggestion',exact:true}).count(),0);assert.equal(await note(page,edited.id).getByRole('button',{name:'Restore this revision',exact:true}).count(),1);
    await showRevisions(page,accepted.id);await note(page,accepted.id).getByRole('button',{name:'Restore suggestion',exact:true}).click();await dialog(page).getByRole('status').filter({hasText:'Suggestion restored.'}).waitFor();await note(page,accepted.id).getByRole('button',{name:'Accept',exact:true}).waitFor();
    assert.equal(restoreRequests[0].body.expectedRevision,2);assert.equal(restoreRequests[0].body.revision,1);assert.equal(memory.suggestions[0].id,accepted.id);assert.equal(memory.entries[0].id,edited.id);assert.equal(memory.entries[0].content,'A later deliberate edit.');
  });
});
