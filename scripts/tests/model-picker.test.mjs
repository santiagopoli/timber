import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A} from './console-fixture.mjs';

let browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const popup=page=>page.locator('.timber-model-picker, .timber-model-popover');
const search=page=>popup(page).getByRole('combobox',{name:'Search models',exact:true});
const providerSearch=page=>popup(page).getByRole('combobox',{name:'Search model providers',exact:true});
const provider=(page,name)=>popup(page).locator(`[data-provider="${name}"]`);
async function bounds(page){
  const box=await popup(page).boundingBox(),size=page.viewportSize();
  assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=size.width&&box.y+box.height<=size.height,'picker fits within the viewport');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
}

for(const width of [1440,390])test(`model picker selects providers before models in every form at ${width}px`,async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900},...(width<760?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();
  page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  fixture.state.modelCatalog.models.push(...Array.from({length:80},(_,i)=>({id:`anthropic/reviewer-${i}`,name:`Claude Reviewer ${i}`,provider:'openrouter',reasoningEfforts:['high'],defaultReasoningEffort:'high',supportsFast:false})),{id:'google/gemini-pro',name:'Gemini Pro',provider:'openrouter',reasoningEfforts:[],supportsFast:false});
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({themes:[],avatars:[],jobs:[],selection:null})}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:'gpt-6.1-sol',name:'Text model',provider:'openai',reasoningEfforts:['medium']}],imageModels:[],unavailableImageModels:[{id:'gpt-image-offline',name:'GPT Image offline',provider:'openai',available:false,reason:'Image API is not configured'}],imageAvailable:false})}));
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();
    if(width<760)await page.locator('.bot-item').first().click();
    await page.locator('#message').fill('A draft that stays intact.');
    const settingsTrigger=page.getByRole('button',{name:/^Model settings:/});await settingsTrigger.click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true});
    assert.equal(await page.getByRole('dialog').count(),1,'the chat opens just one panel');
    assert.equal(await settings.locator('[aria-haspopup]').count(),0,'no settings control opens a nested dropdown');await providerSearch(page).and(page.locator(':focus')).waitFor();await bounds(page);
    assert.equal(await popup(page).getByRole('option').count(),3,'82 models start as just three providers');
    await provider(page,'OpenAI').locator('[aria-label="Current provider"]').waitFor();
    assert.equal(await popup(page).locator('.timber-model-option-id').count(),0,'the first step does not list individual models');
    await providerSearch(page).fill('no-such-family');await popup(page).getByText('No model providers match your search.',{exact:true}).waitFor();
    await providerSearch(page).fill('Anthropic');await page.keyboard.press('Enter');await search(page).and(page.locator(':focus')).waitFor();
    assert.equal(await popup(page).getByRole('option').count(),80,'OpenRouter routes are grouped by their creator');
    assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,0,'choosing a provider never changes model settings');
    await search(page).fill('no-such-model');await popup(page).getByText('No models match your search.',{exact:true}).waitFor();
    await search(page).fill('reviewer-79');assert.equal(await popup(page).getByRole('option').count(),1);
    if(process.env.TIMBER_CAPTURE_UI)await page.screenshot({path:`/tmp/timber-picker-${width}.png`});
    await page.keyboard.press('Enter');await settingsTrigger.filter({hasText:'Reviewer 79'}).waitFor();
    assert.equal(fixture.state.bots.find(bot=>bot.id===BOT_A).model,'anthropic/reviewer-79');
    assert.equal(await page.locator('#message').inputValue(),'A draft that stays intact.');
    await settings.getByRole('button',{name:'Close model settings'}).click();await settingsTrigger.click();assert.equal(await providerSearch(page).inputValue(),'','every opening starts with providers and clears the search');
    await provider(page,'Anthropic').locator('[aria-label="Current provider"]').waitFor();await provider(page,'Anthropic').click();
    await popup(page).locator('[data-current=true] [aria-label="Current model"]').waitFor();
    await search(page).fill('reviewer-12');await popup(page).getByRole('button',{name:'Back to model providers'}).click();
    assert.equal(await providerSearch(page).inputValue(),'');await provider(page,'OpenAI').click();assert.equal(await popup(page).getByRole('option').count(),1,'switching providers excludes the previous provider');
    assert.equal(await page.getByRole('dialog').count(),1,'provider navigation keeps the same panel');
    await page.keyboard.press('Escape');await popup(page).waitFor({state:'hidden'});await settingsTrigger.and(page.locator(':focus')).waitFor();

    if(!await page.locator('#edit-bot').isVisible())await page.locator('#panel-menu > summary').click();
    await page.locator('#edit-bot').click();const edit=page.locator('#edit-model-picker');await edit.click();await bounds(page);
    assert.equal(await popup(page).evaluate(node=>node.closest('dialog')?.id),'edit-dialog','picker remains in the native modal top layer');
    await provider(page,'Anthropic').click();await page.keyboard.press('ArrowDown');assert.notEqual(await popup(page).locator('[data-selected=true]').getAttribute('data-value'),'anthropic/reviewer-79','arrow keys navigate the provider models');await search(page).fill('reviewer-12');await page.keyboard.press('Enter');
    assert.equal(await edit.getAttribute('title'),'anthropic/reviewer-12');assert.equal(await page.locator('#edit-reasoning').inputValue(),'high');
    await page.locator('#edit-form [type=submit]').click();await page.locator('#edit-dialog').waitFor({state:'hidden'});
    assert.equal(fixture.state.bots.find(bot=>bot.id===BOT_A).model,'anthropic/reviewer-12');

    if(width<760)await page.locator('#mobile-back').click();
    await page.locator('#new-bot').click();await page.locator('#bot-name').fill('Searchable models');await page.locator('#bot-model-picker').click();await bounds(page);
    assert.equal(await popup(page).getByRole('option').count(),3);await provider(page,'Anthropic').click();
    await search(page).fill('reviewer-42');await popup(page).locator('[data-value="anthropic/reviewer-42"]').click();assert.equal(await page.locator('#bot-model').inputValue(),'anthropic/reviewer-42');
    await page.locator('#create-form [type=submit]').click();await page.locator('#bot-dialog').waitFor({state:'hidden'});assert.equal(fixture.state.bots.find(bot=>bot.name==='Searchable models').model,'anthropic/reviewer-42');

    if(!await page.locator('#settings-button').isVisible()){await page.locator('#panel-menu > summary').click();await page.locator('#mobile-account').click();}
    else await page.locator('#settings-button').click();
    await page.locator('#avatar-create-details > summary').click();await page.locator('#avatar-theme-kind').selectOption('image');await page.locator('#avatar-theme-model-picker').click();await bounds(page);await provider(page,'OpenAI').click();
    await popup(page).getByText('Image API is not configured',{exact:true}).waitFor();
    await popup(page).getByRole('option').getByText('Image API',{exact:true}).waitFor();await popup(page).getByRole('option').locator('[aria-label="Input: price unavailable"]').waitFor();assert.doesNotMatch(await popup(page).getByRole('option').innerText(),/Uses ChatGPT allowance/);
    assert.equal(await popup(page).getByRole('option').getAttribute('aria-disabled'),'false','unavailable image models remain selectable for saved theme configuration');
    await page.keyboard.press('Escape');assert.ok(await page.locator('#settings-dialog').isVisible());
    assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);
  }finally{await page.unrouteAll({behavior:'wait'});await context.close();await fixture.close();}
});

test('saved models outside the catalogue remain visible in their provider without unsupported writes',async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(6000);
  fixture.state.bots[0].model='retired-model';
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();
    await page.getByRole('button',{name:'Model settings: retired-model',exact:true}).click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true});
    await provider(page,'Other providers').click();await search(page).fill('retired-model');
    const retired=popup(page).getByRole('option');assert.equal(await retired.getAttribute('aria-disabled'),'true');await retired.getByText('Saved model is not in the current catalogue',{exact:true}).waitFor();
    await page.keyboard.press('Enter');assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,0);assert.ok(await popup(page).isVisible());
    await popup(page).getByRole('button',{name:'Back to model providers'}).click();await provider(page,'OpenAI').click();
    await search(page).fill('gpt-6.1-sol');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Model settings: GPT-6.1 Sol',exact:true}).waitFor();
    assert.equal(fixture.state.bots[0].model,'gpt-6.1-sol');assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,1);
    await popup(page).getByRole('button',{name:'Back to model providers'}).click();await provider(page,'OpenAI').click();await search(page).fill('gpt-6.1-sol');await page.keyboard.press('Enter');assert.ok(await settings.isVisible());assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,1,'choosing the current model does not write again');
  }finally{await context.close();await fixture.close();}
});

test('a publisher prefix from OpenRouter is not repeated in the visible model name',async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  fixture.state.modelCatalog.models.push({id:'anthropic/claude-opus-5.5',name:'Anthropic: Claude Opus 5.5',provider:'openrouter',reasoningEfforts:['high'],defaultReasoningEffort:'high',supportsFast:false});
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();
    await page.getByRole('button',{name:/^Model settings:/}).click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true});
    assert.equal(await page.getByRole('dialog').count(),1,'the chat opens just one panel');
    assert.equal(await settings.locator('[aria-haspopup]').count(),0,'no settings control opens a nested dropdown');
    await provider(page,'Anthropic').click();
    const option=popup(page).locator('[data-value="anthropic/claude-opus-5.5"]');
    await option.waitFor();
    assert.match(await option.innerText(),/^Claude Opus 5\.5/,'visible name drops the repeated publisher prefix');
    assert.doesNotMatch(await option.innerText(),/Anthropic: /);
    assert.deepEqual(errors,[]);
  }finally{await context.close();await fixture.close();}
});

for(const width of [1440,390])test(`model prices follow subscription, paid fallback and source disconnection at ${width}px`,async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900},...(width<760?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();page.setDefaultTimeout(6000);
  const base=fixture.state.modelCatalog.models[0];
  const subscription={...base,source:'chatgpt',modelId:base.id,contextWindow:128000};
  const api={...base,source:'openai-api',provider:'openai-api',modelId:base.id,contextWindow:128000,pricing:{input:2,output:10,cachedInput:.1}};
  const router={...base,id:`openai/${base.id}`,source:'openrouter',provider:'openrouter',modelId:`openai/${base.id}`,supportsFast:false,contextWindow:128000,pricing:{input:3,output:15,cachedInput:.3}};
  const claude={id:'anthropic/claude-reviewer',name:'Claude reviewer',provider:'openrouter',reasoningEfforts:[],supportsFast:false};
  fixture.state.modelCatalog={...fixture.state.modelCatalog,sources:[{id:'chatgpt',connected:true},{id:'openai-api',connected:true},{id:'openrouter',connected:true}],models:[{...base,routes:[subscription,api,router]},{...claude,routes:[{...claude,source:'openrouter',modelId:claude.id,pricing:{input:3,output:15},contextWindow:128000}]}]};
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();
    if(width<760)await page.locator('.bot-item').first().click();
    const trigger=page.getByRole('button',{name:/^Model settings:/});await trigger.click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true}),billing=settings.getByRole('table',{name:'Model usage and pricing'});
    assert.equal(await billing.isVisible(),false,'detailed billing starts collapsed');
    await provider(page,'OpenAI').click();const option=settings.getByRole('option');
    await option.getByText('ChatGPT plan',{exact:true}).waitFor();await option.getByText('Fallback: OpenAI API',{exact:true}).waitFor();
    await option.locator('[aria-label="Input: $2"]').waitFor();await option.locator('[aria-label="Output: $10"]').waitFor();
    assert.equal(await option.locator('.timber-model-option-id').count(),0,'a model row does not repeat its ID');
    assert.ok((await option.boundingBox()).height<=70,'a priced model fits in a compact two-line row');
    await bounds(page);assert.equal(await page.getByRole('dialog').count(),1,'pricing does not introduce another popup');
    await settings.getByLabel('Usage and prices',{exact:true}).click();await billing.waitFor();
    const plan=billing.locator('[data-source="chatgpt"]'),apiRow=billing.locator('[data-source="openai-api"]'),routerRow=billing.locator('[data-source="openrouter"]');
    await plan.getByText('Plan allowance',{exact:true}).waitFor();
    await apiRow.getByText('$2',{exact:true}).waitFor();await apiRow.getByText('$10',{exact:true}).waitFor();await apiRow.getByText('$0.1',{exact:true}).waitFor();await apiRow.getByText('Fallback 1',{exact:true}).waitFor();
    await routerRow.getByText('$3',{exact:true}).waitFor();await routerRow.getByText('$0.3',{exact:true}).waitFor();await routerRow.getByText('Fallback 2',{exact:true}).waitFor();
    await settings.getByRole('switch',{name:'Fast mode'}).click();await trigger.locator('[aria-label="Fast mode"]').waitFor();
    await routerRow.getByText('Fast unsupported',{exact:true}).waitFor();assert.equal(await routerRow.getByText('$3',{exact:true}).count(),0,'an incompatible fallback is not quoted as active');
    await apiRow.getByText('Fast price unavailable',{exact:true}).waitFor();assert.equal(await apiRow.getByText('$2',{exact:true}).count(),0,'standard prices are never quoted as Fast prices');
    await settings.getByRole('switch',{name:'Fast mode'}).click();await trigger.locator('[aria-label="Fast mode"]').waitFor({state:'hidden'});
    await settings.getByRole('button',{name:'Close model settings'}).click();
    await page.route('**/v1/connections/chatgpt',route=>{
      if(route.request().method()!=='DELETE')return route.continue();
      fixture.state.modelCatalog.models[0]={...base,provider:'openai-api',routes:[api,router]};fixture.state.modelCatalog.sources[0].connected=false;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,status:'disconnected',revoked:true})});
    });
    if(!await page.locator('#settings-button').isVisible()){await page.locator('#panel-menu > summary').click();await page.locator('#mobile-account').click();}else await page.locator('#settings-button').click();
    await page.locator('#disconnect-chatgpt').click();await page.locator('#chatgpt-status').filter({hasText:'Not connected'}).waitFor();await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await trigger.click();await settings.locator('summary').getByText('OpenAI API',{exact:true}).waitFor();await settings.getByLabel('Usage and prices',{exact:true}).click();
    await billing.locator('[data-source="openai-api"] td').first().filter({hasText:'$2'}).waitFor();assert.equal(await billing.getByText('Plan allowance',{exact:true}).count(),0);
    await billing.locator('[data-source="openrouter"]').getByText('Fallback 1',{exact:true}).waitFor();await settings.getByRole('button',{name:'Close model settings'}).click();
    if(!await page.locator('#edit-bot').isVisible())await page.locator('#panel-menu > summary').click();await page.locator('#edit-bot').click();
    await page.locator('#edit-model-help').filter({hasText:'$2 in / $10 out · USD / 1M tokens'}).waitFor();
    await page.locator('#edit-fast').check();await page.locator('#edit-model-help').filter({hasText:'Fast price unavailable'}).waitFor();await page.getByRole('button',{name:'Close edit bot'}).click();
    if(width<760)await page.locator('#mobile-back').click();await page.locator('#new-bot').click();await page.locator('#bot-model-picker').click();await provider(page,'Anthropic').click();
    await popup(page).getByRole('option').locator('[aria-label="Input: $3"]').waitFor();await popup(page).getByRole('option').click();
    await page.locator('#bot-model-help').filter({hasText:'OpenRouter · $3 in / $15 out · USD / 1M tokens'}).waitFor();assert.doesNotMatch(await page.locator('#bot-model-help').innerText(),/ChatGPT/);
    assert.deepEqual(fixture.state.failures,[]);
  }finally{await page.unrouteAll({behavior:'wait'});await context.close();await fixture.close();}
});

for(const viewport of [{width:1440,height:900},{width:390,height:700},{width:320,height:700},{width:390,height:500}])test(`compact model comparison keeps settings accessible at ${viewport.width}x${viewport.height}`,async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport}),page=await context.newPage();page.setDefaultTimeout(6000);
  const base={...fixture.state.modelCatalog.models[0],reasoningEfforts:['none','minimal','low','medium','high','xhigh','max']};
  fixture.state.modelCatalog.models=Array.from({length:16},(_,i)=>{
    const item={...base,id:i?`reviewer-${i}`:base.id,name:i?`Reviewer ${i}`:base.name};
    return {...item,routes:[{...item,source:'chatgpt',modelId:item.id},{...item,source:'openai-api',provider:'openai-api',modelId:item.id,contextWindow:128000,pricing:{input:2+i,output:10+i,cachedInput:.1}},{...item,source:'openrouter',provider:'openrouter',modelId:`openai/${item.id}`,contextWindow:128000,pricing:{input:3,output:15},supportsFast:false}]};
  });
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();if(viewport.width<760)await page.locator('.bot-item').first().click();
    await page.locator('#message').fill('Keep my draft');await page.getByRole('button',{name:/^Model settings:/}).click();const settings=page.getByRole('dialog',{name:'Model settings',exact:true});
    await provider(page,'OpenAI').click();await bounds(page);
    assert.equal(await settings.locator('.timber-model-picker-heading').count(),1,'navigation has one header');
    assert.equal(await settings.getByRole('table').isVisible(),false,'the price table is secondary information');
    const list=settings.getByRole('listbox'),listBox=await list.boundingBox(),rows=await settings.getByRole('option').all();let visible=0;
    for(const row of rows){const box=await row.boundingBox();assert.ok(box.height<=70,'each priced model uses two short lines');if(box.y>=listBox.y&&box.y+box.height<=listBox.y+listBox.height)visible++;}
    if(viewport.height>=700)assert.ok(visible>=3,'several models are fully visible for comparison');
    const controls=settings.getByRole('group',{name:'Reasoning effort'}),fast=settings.getByRole('switch',{name:'Fast mode'});
    const inPanel=async locator=>{const box=await locator.boundingBox(),panel=await settings.boundingBox();assert.ok(box.y>=panel.y&&box.y+box.height<=panel.y+panel.height,'settings stay inside the visible panel');};
    await inPanel(controls);await inPanel(fast);assert.equal(await controls.getByRole('button').count(),7);
    const before=await controls.boundingBox();await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});const after=await controls.boundingBox();assert.equal(after.y,before.y,'scrolling the catalogue does not move the settings');
    await settings.getByLabel('Usage and prices',{exact:true}).click();await settings.getByRole('table').waitFor();await bounds(page);await inPanel(controls);await inPanel(fast);
    assert.equal(await page.getByRole('dialog').count(),1,'billing details expand inside the existing panel');
    await settings.getByLabel('Usage and prices',{exact:true}).focus();await page.keyboard.press('Space');await settings.getByRole('table').waitFor({state:'hidden'});
    await search(page).fill('reviewer-15');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Model settings: Reviewer 15',exact:true}).waitFor();
    assert.equal(await page.locator('#message').inputValue(),'Keep my draft');assert.deepEqual(fixture.state.failures,[]);
  }finally{await context.close();await fixture.close();}
});
