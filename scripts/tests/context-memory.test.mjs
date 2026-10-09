import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A} from './console-fixture.mjs';

let browser;
after(async()=>{await browser?.close();});
async function withPage(work,width=1440) {
  browser??=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
  const memory={content:'Use concise answers.',revision:1,maxCharacters:16000};
  const status={automatic:true,estimatedTokens:42000,activeEntries:50,contextWindow:128000,historyRetained:true,compactions:[]};
  const writes=[],compactions=[];
  await page.route(`**/v1/bots/${BOT_A}/memory`,async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{memory}});
    const input=route.request().postDataJSON();writes.push(input);
    if(input.revision!==memory.revision)return route.fulfill({status:409,json:{error:{code:'memory_conflict',message:'Memory changed. Reload it before saving your changes.'}}});
    Object.assign(memory,{content:input.content,revision:memory.revision+1});return route.fulfill({json:{memory}});
  });
  await page.route(`**/v1/bots/${BOT_A}/context`,route=>route.fulfill({json:{context:status}}));
  await page.route(`**/v1/bots/${BOT_A}/context/compact`,route=>{
    compactions.push(route.request().postDataJSON());status.compactions=[{id:'compact:one',reason:'manual',status:'completed',summaryApplied:true}];status.estimatedTokens=12000;
    return route.fulfill({status:202,json:{compaction:status.compactions[0]}});
  });
  const login=async()=>{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
    if(width<=760)await page.locator('.bot-item').first().click();
    await page.getByRole('button',{name:'Context and memory',exact:true}).click();await page.getByRole('textbox',{name:'Durable notes'}).waitFor();
  };
  try{await work({...fixture,page,context,login,memory,status,writes,compactions});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);}
  finally{await context.close();await fixture.close();}
}

test('context and memory keeps a conflicting draft, saves with revision, and compacts without replacing conversation history',async()=>{
  for(const width of [1440,390])await withPage(async({page,login,memory,writes,compactions})=>{
    await login();const dialog=page.getByRole('dialog',{name:'Context and memory'}),notes=dialog.getByRole('textbox',{name:'Durable notes'});
    assert.equal(await notes.inputValue(),'Use concise answers.');
    await notes.fill('Keep confirmed decisions and exact file paths.');memory.revision++;
    await dialog.getByRole('button',{name:'Save notes',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Memory changed'}).waitFor();
    assert.equal(await notes.inputValue(),'Keep confirmed decisions and exact file paths.','CAS conflict preserves unsaved edits');
    await dialog.getByRole('button',{name:'Reload saved notes',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#timber-memory-notes').value==='Use concise answers.');
    await notes.fill('Retain verified decisions.');await dialog.getByRole('button',{name:'Save notes',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Memory saved.'}).waitFor();
    assert.deepEqual(writes.map(item=>item.revision),[1,2]);assert.equal(memory.content,'Retain verified decisions.');
    const historySnapshot=()=>page.locator('#messages [data-message-id]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-message-id'),text:node.querySelector('.timber-message-content')?.textContent})));
    const historyBefore=await historySnapshot();
    await dialog.getByRole('button',{name:'Compact now',exact:true}).click();await dialog.locator('[data-compaction-status="completed"]').waitFor();
    assert.equal(compactions.length,1);assert.ok(compactions[0].operationId);
    assert.deepEqual(await historySnapshot(),historyBefore,'Compaction preserves every visible message; maintenance pills may be added.');
    assert.match(await dialog.innerText(),/Full history retained/);
    const geometry=await dialog.boundingBox();assert.ok(geometry.x>=0&&geometry.x+geometry.width<=width);
    if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/context-memory-${width}.png`,animations:'disabled'});}
    await dialog.getByRole('button',{name:'Close context and memory',exact:true}).click();await page.reload();
    await page.getByRole('button',{name:'Context and memory',exact:true}).waitFor();
    await page.getByRole('button',{name:'Context and memory',exact:true}).click();await notes.waitFor();assert.equal(await notes.inputValue(),'Retain verified decisions.');
  },width);
});

test('manual compaction retries an unconfirmed receipt with the same operation identity',async()=>{
  await withPage(async({page,login,status})=>{
    const submissions=[];
    await page.route(`**/v1/bots/${BOT_A}/context/compact`,route=>{
      submissions.push(route.request().postDataJSON());
      if(submissions.length===1)return route.abort('failed');
      status.compactions=[{id:'compact:recovered',reason:'manual',status:'completed',summaryApplied:true}];
      return route.fulfill({status:202,json:{compaction:status.compactions[0]}});
    });
    await login();const dialog=page.getByRole('dialog',{name:'Context and memory'});
    await dialog.getByRole('button',{name:'Compact now',exact:true}).click();await dialog.getByRole('alert').waitFor();
    await dialog.getByRole('button',{name:'Compact now',exact:true}).click();await dialog.locator('[data-compaction-status="completed"]').waitFor();
    assert.equal(submissions.length,2);assert.equal(submissions[0].operationId,submissions[1].operationId);
  });
});
