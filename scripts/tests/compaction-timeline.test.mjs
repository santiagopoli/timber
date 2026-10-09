import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';

const base='2026-10-05T10:01:00.000Z';
const receipt=(id,changes={})=>({id,reason:'threshold',status:'completed',summaryApplied:true,createdAt:base,...changes});
const event=(id,compaction,changes={})=>({id,botId:BOT_A,type:'context.compaction',data:{compaction},createdAt:compaction.createdAt||base,...changes});
let projection;
async function helper() {
  projection??=(async()=>{
    const result=await build({entryPoints:[new URL('../../apps/console/src/compaction-timeline.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',loader:{'.css':'empty'},jsx:'automatic'});
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  })();
  return (await projection).collectCompactions;
}

test('compaction projection keeps distinct occurrences and merges lifecycle/replayed identities',async()=>{
  const collect=await helper(),running=receipt('compact:one',{status:'running',summaryApplied:false}),completed=receipt('compact:one');
  const events=[event(1,running),event(2,completed),event(3,receipt('compact:two')),event(4,running)];
  const items=collect({events:[...events,events[1]],compactionEvents:[events[0],events[1]]});
  assert.deepEqual(items.map(item=>item.id),['compact:one','compact:two']);
  assert.equal(items[0].status,'completed','late running replay cannot reopen a settled occurrence');
  assert.equal(items[0].createdAt,base);
  assert.notEqual(items[0].key,items[1].key,'same time, reason and status are not occurrence identity');
  assert.equal(collect({events:[],compactions:Array.from({length:40},(_,index)=>receipt(`compact:history-${index}`))}).length,40,'all historical receipts are retained, not just the latest 20');
});

test('compaction projection uses real timestamps, scopes child/run history, and drops unreviewed native data',async()=>{
  const collect=await helper();
  const known=receipt('compact:known',{updatedAt:'2026-10-05T10:02:00.000Z',summaryCreatedAt:'2026-10-05T10:02:00.000Z',estimatedTokensBefore:14000,firstKeptEntryId:30,summarizedEntries:20,model:'unreviewed-model',summary:'private',internalSummary:'private',instructions:'private',usage:{secret:'private'}});
  const items=collect({compactions:[known,receipt('compact:legacy',{createdAt:undefined})],events:[
    event(1,receipt('compact:child'),{data:{compaction:receipt('compact:child'),subagentId:'child-1'},runId:'child-run'}),
    event(2,receipt('compact:run'),{runId:'run-one'}),
    event(3,receipt('compact:malformed',{status:'invented'})),
  ]});
  assert.deepEqual(items.map(item=>item.id),['compact:legacy','compact:known','compact:run']);
  assert.equal(items[0].createdAt,'','an undated legacy compaction remains visible without invented time');
  assert.equal(items[0].unpositioned,true,'unknown dates are explicitly grouped outside chronology');
  assert.equal(items[1].unpositioned,false);
  assert.equal(items[1].firstKeptEntryId,30);assert.equal(items[1].summarizedEntries,20);
  assert.equal(items[1].estimatedTokensBefore,14000);
  for(const name of ['updatedAt','summary','model','internalSummary','instructions','usage'])assert.equal(name in items[1],false);
  const [automatic]=collect({events:[],compactions:[receipt('compact:auto',{createdAt:undefined,startedAt:base})]});
  assert.equal(automatic.createdAt,base);assert.equal(automatic.timestampSource,'startedAt');
  assert.deepEqual(collect({events:[event(2,receipt('compact:run'),{runId:'run-one'})],runFilter:'other-run'}),[]);
  assert.equal(collect({events:[event(1,receipt('compact:child'),{data:{compaction:receipt('compact:child'),subagentId:'child-1'}})]},'child-1').length,1);
});

test('compaction projection preserves original placement on completion and ignores invalid metrics',async()=>{
  const collect=await helper(),first=event(1,receipt('compact:progress',{createdAt:undefined,status:'running',summaryApplied:false}));
  const finished=event(2,receipt('compact:progress',{createdAt:undefined,estimatedTokensBefore:-1,summarizedEntries:NaN}),{createdAt:'2026-10-05T10:10:00.000Z'});
  const [item]=collect({events:[finished,first]});
  assert.equal(item.createdAt,base);assert.equal(item.status,'completed');
  assert.equal(item.estimatedTokensBefore,undefined);assert.equal(item.summarizedEntries,undefined);
  assert.deepEqual(collect({events:[event(3,receipt('',{createdAt:'not a date'}))]}),[]);
});

let browser;
after(async()=>{await browser?.close();});
async function withPage(width,work) {
  browser??=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900},colorScheme:width===320?'dark':'light'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  try{await work({...fixture,page});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);}
  finally{await context.close();await fixture.close();}
}
async function login(page,width) {
  await page.goto(page.fixtureURL);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  if(width<=760)await page.locator(`[data-bot-id="${BOT_A}"]`).click();
  await page.locator('#stream-state').filter({hasText:'Live'}).waitFor({state:'attached'});
}

for(const width of [320,1440])test(`compaction browser timeline keeps each historical/live/reload occurrence and keyboard capsule at ${width}px`,async()=>{
  await withPage(width,async({page,url,state})=>{
    page.fixtureURL=url;
    const publicError=`Recorded public diagnostic. ${'LongUnbrokenDetail'.repeat(80)}\n<script>must stay text</script>`;
    const receipts=[receipt('compact:manual',{reason:'manual',status:'failed',summaryApplied:false,error:publicError,estimatedTokensBefore:14000,summarizedEntries:20,firstKeptEntryId:30}),receipt('compact:auto',{reason:'overflow'}),receipt('compact:undated',{createdAt:undefined,status:'unchanged',summaryApplied:false})];
    await page.clock.install();
    state.messages.set(BOT_A,[
      {id:'before-compact',botId:BOT_A,role:'user',text:'Older history before compaction',createdAt:'2026-10-05T10:00:00.000Z'},
      {id:'after-compact',botId:BOT_A,role:'assistant',text:'New history after compaction',createdAt:'2026-10-05T10:02:00.000Z'},
    ]);
    // The actual historical/live transport is a complete GET /context snapshot.
    // Public API fixtures contain no raw native tasks or invented SSE events.
    await page.route(`**/v1/bots/${BOT_A}/context`,route=>route.fulfill({json:{context:{automatic:true,estimatedTokens:6000,activeEntries:20,contextWindow:128000,historyRetained:true,compactions:receipts}}}));
    await login(page,width);
    const manual=page.locator('[data-compaction-id="compact:manual"]'),pill=manual.locator('.timber-compaction-pill');
    await manual.waitFor();assert.equal(await page.locator('#messages [data-compaction-id]').count(),3);
    const undated=page.locator('[aria-label="Compaction history with unavailable dates"] [data-compaction-id="compact:undated"]');
    await undated.waitFor();assert.match(await undated.innerText(),/Date unavailable/);
    assert.equal(await page.locator('.timber-compaction-details').count(),0,'closed details are not mounted');
    assert.equal(await page.getByText(publicError,{exact:true}).count(),0,'recorded diagnostics are expanded-only');
    const box=await pill.boundingBox();assert.ok(box.height>=44);assert.ok(box.width<360&&box.x>=0&&box.x+box.width<=width);
    assert.equal(await pill.evaluate(node=>Number.parseFloat(getComputedStyle(node).borderRadius)),999,'retain actual capsule silhouette');
    assert.equal(await pill.locator('button').count(),0,'no nested buttons');
    await pill.focus();await page.keyboard.press('Enter');assert.equal(await pill.getAttribute('aria-expanded'),'true');
    const detailId=await pill.getAttribute('aria-controls'),detail=page.locator(`[id="${detailId}"]`);await detail.waitFor();
    assert.match(await detail.innerText(),/14,000/);assert.match(await detail.innerText(),/Selected-prefix tokens \(estimate\)/);assert.match(await detail.innerText(),/First entry kept verbatim/);
    assert.equal(await detail.locator('script').count(),0,'public diagnostics are plain text, not injected HTML');
    assert.match(await detail.innerText(),/<script>must stay text<\/script>/);
    const bounds=await detail.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    assert.equal(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'long text stays bounded');
    await pill.focus();await page.keyboard.press('Space');assert.equal(await pill.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.timber-compaction-details').count(),0);
    // New automatic compaction arrives in a passive context poll; completion
    // updates the same capsule without deleting messages. Advance the browser
    // clock instead of spending real time waiting on battery-friendly timers.
    const live=receipt('compact:live',{createdAt:'2026-10-05T10:03:00.000Z',status:'running',summaryApplied:false});
    receipts.push(live);
    await page.clock.fastForward(31000);
    const livePill=page.locator('[data-compaction-id="compact:live"]');await livePill.waitFor();
    Object.assign(live,{status:'completed',summaryApplied:true});
    await page.clock.fastForward(16000);
    await page.locator('[data-compaction-id="compact:live"][data-compaction-status="completed"]').waitFor();
    assert.equal(await page.locator('#messages [data-compaction-id]').count(),4);
    await page.reload();await manual.waitFor();assert.equal(await page.locator('#messages [data-compaction-id]').count(),4);
    const order=await page.locator('#messages [data-message-id], #messages [data-compaction-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-message-id')||node.getAttribute('data-compaction-id')));
    assert.ok(order.indexOf('before-compact')<order.indexOf('compact:manual'));assert.ok(order.indexOf('compact:auto')<order.indexOf('after-compact'));
    assert.match(await page.locator('#messages').innerText(),/Older history before compaction/);assert.match(await page.locator('#messages').innerText(),/New history after compaction/);
    const otherBot=page.locator(`[data-bot-id="${BOT_B}"]`);if(!await otherBot.isVisible())await page.locator('#mobile-back').click();await otherBot.click();
    await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();assert.equal(await page.locator('[data-compaction-id]').count(),0,'bot switch cannot leak old compactions');
  });
});
