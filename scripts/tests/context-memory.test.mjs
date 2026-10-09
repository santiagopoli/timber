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
