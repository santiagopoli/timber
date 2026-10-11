import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A} from './console-fixture.mjs';

let browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const popup=page=>page.getByRole('dialog',{name:'Choose model',exact:true});
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
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true}),model=settings.getByRole('combobox',{name:'Model',exact:true});
    await model.click();await providerSearch(page).and(page.locator(':focus')).waitFor();await bounds(page);
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
    await model.click();assert.equal(await providerSearch(page).inputValue(),'','every opening starts with providers and clears the search');
    await provider(page,'Anthropic').locator('[aria-label="Current provider"]').waitFor();await provider(page,'Anthropic').click();
    await popup(page).locator('[data-current=true] [aria-label="Current model"]').waitFor();
    await search(page).fill('reviewer-12');await popup(page).getByRole('button',{name:'Back to model providers'}).click();
    assert.equal(await providerSearch(page).inputValue(),'');await provider(page,'OpenAI').click();assert.equal(await popup(page).getByRole('option').count(),1,'switching providers excludes the previous provider');
    await page.keyboard.press('Escape');await popup(page).waitFor({state:'hidden'});await model.and(page.locator(':focus')).waitFor();assert.ok(await settings.isVisible());
    await settings.getByRole('button',{name:'Close model settings'}).click();

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
    await search(page).fill('reviewer-42');await popup(page).getByRole('option').filter({hasText:'anthropic/reviewer-42'}).click();assert.equal(await page.locator('#bot-model').inputValue(),'anthropic/reviewer-42');
    await page.locator('#create-form [type=submit]').click();await page.locator('#bot-dialog').waitFor({state:'hidden'});assert.equal(fixture.state.bots.find(bot=>bot.name==='Searchable models').model,'anthropic/reviewer-42');

    if(!await page.locator('#settings-button').isVisible()){await page.locator('#panel-menu > summary').click();await page.locator('#mobile-account').click();}
    else await page.locator('#settings-button').click();
    await page.locator('#avatar-create-details > summary').click();await page.locator('#avatar-theme-kind').selectOption('image');await page.locator('#avatar-theme-model-picker').click();await bounds(page);await provider(page,'OpenAI').click();
    await popup(page).getByText('Image API is not configured · Configuration only',{exact:true}).waitFor();
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
    const model=page.getByRole('dialog',{name:'Model settings',exact:true}).getByRole('combobox',{name:'Model',exact:true});
    await model.click();await provider(page,'Other providers').click();await search(page).fill('retired-model');
    const retired=popup(page).getByRole('option');assert.equal(await retired.getAttribute('aria-disabled'),'true');await retired.getByText('Saved model is not in the current catalogue',{exact:true}).waitFor();
    await page.keyboard.press('Enter');assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,0);assert.ok(await popup(page).isVisible());
    await popup(page).getByRole('button',{name:'Back to model providers'}).click();await provider(page,'OpenAI').click();
    await search(page).fill('gpt-6.1-sol');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Model settings: GPT-6.1 Sol',exact:true}).waitFor();
    assert.equal(fixture.state.bots[0].model,'gpt-6.1-sol');assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,1);
    await model.click();await provider(page,'OpenAI').click();await search(page).fill('gpt-6.1-sol');await page.keyboard.press('Enter');await popup(page).waitFor({state:'hidden'});assert.equal(fixture.state.calls.filter(call=>call.method==='PATCH').length,1,'choosing the current model does not write again');
  }finally{await context.close();await fixture.close();}
});

test('a publisher prefix from OpenRouter is not repeated in the visible model name',async()=>{
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  fixture.state.modelCatalog.models.push({id:'anthropic/claude-opus-5.5',name:'Anthropic: Claude Opus 5.5',provider:'openrouter',reasoningEfforts:['high'],defaultReasoningEffort:'high',supportsFast:false});
  try{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();
    await page.getByRole('button',{name:/^Model settings:/}).click();
    const settings=page.getByRole('dialog',{name:'Model settings',exact:true}),model=settings.getByRole('combobox',{name:'Model',exact:true});
    await model.click();
    await provider(page,'Anthropic').click();
    const option=popup(page).locator('[data-value="anthropic/claude-opus-5.5"]');
    await option.waitFor();
    assert.match(await option.innerText(),/^Claude Opus 5\.5/,'visible name drops the repeated publisher prefix');
    assert.doesNotMatch(await option.innerText(),/Anthropic: /);
    assert.deepEqual(errors,[]);
  }finally{await context.close();await fixture.close();}
});
