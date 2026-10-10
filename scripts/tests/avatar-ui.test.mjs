import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';

// Keep the mutation response pending so these regressions exercise the loading
// render deterministically, rather than depending on CI/network timing.
function responseGate(){
 const entered=Promise.withResolvers(),response=Promise.withResolvers();
 return {entered:entered.promise,release:response.resolve,async hold(){entered.resolve();await response.promise;}};
}
async function waitForGlobalSelection(page,themeId,revision){
 // An existing avatar can be visible during loading. The committed revision is
 // the observable completion signal; do not mistake that old image for a PUT ack.
 await page.waitForFunction(({themeId,revision})=>document.querySelector('#avatar-status').textContent===`Global selection · revision ${revision}`&&document.querySelector('#avatar-theme-select').value===themeId,{themeId,revision});
}

test('image API catalogue is independent of SIWC and batch generation requires exact billing confirmation',async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const themes=[{id:'theme-vector',name:'Paper sculpture',kind:'vector',prompt:'Paper character',model:'gpt-6.1-sol',createdAt:'2026-10-01T00:00:00.000Z'}];
 let selection={themeId:'theme-vector',revision:1};const calls=[],applyResponse=responseGate();
 const settings=()=>({themes:structuredClone(themes),selection:{...selection},avatars:[],jobs:[]});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});await page.addInitScript(()=>{window.confirm=message=>{window.__avatarConfirmation=message;return true;};});
  await page.route('**/v1/avatar-settings',async route=>{if(route.request().method()==='PUT'){selection={themeId:route.request().postDataJSON().themeId,revision:selection.revision+1};await applyResponse.hold();}await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(settings())});});
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,vectorModels:[],imageModels:[
   {id:'gpt-image-2.5-sunburst',name:'GPT Image 2.5 Sunburst',provider:'openai',billing:'openai-api'},
   {id:'gpt-image-2.5-flare',name:'GPT Image 2.5 Flare',provider:'openai',billing:'openai-api'},
  ],imageAvailable:true,imageBilling:{provider:'openai-api',separateFromChatGPT:true,costKnown:false,message:'Billed separately by OpenAI API; not included with ChatGPT.'}})}));
  await page.route('**/v1/avatar-themes',async route=>{const body=route.request().postDataJSON();calls.push({path:'/v1/avatar-themes',body});const theme={id:'theme-image',...body,createdAt:'2026-10-01T00:00:01.000Z'};themes.push(theme);await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({theme})});});
  await page.route('**/v1/avatar-generations',async route=>{calls.push({path:'/v1/avatar-generations',body:route.request().postDataJSON()});await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({jobs:[]})});});
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#settings-button').click();await page.locator('#avatar-create-details > summary').click();await page.locator('#avatar-theme-kind').selectOption('image');
  const model=page.locator('#avatar-theme-model');await model.locator('option[value="gpt-image-2.5-sunburst"]').waitFor({state:'attached'});
  assert.match(await page.locator('#avatar-image-capability').textContent(),/cost is unknown/i);
  await page.locator('#avatar-theme-name').fill('Sunburst setup');await page.locator('#avatar-theme-prompt').fill('Consistent image avatar style.');await model.selectOption('gpt-image-2.5-sunburst');await page.locator('#avatar-create-submit').click();
  await page.locator('#avatar-theme-select option[value="theme-image"]').waitFor({state:'attached'});await page.locator('#avatar-theme-select').selectOption('theme-image');await page.locator('#avatar-apply-theme').click();
  await applyResponse.entered;
  assert.equal(await page.locator('#avatar-status').textContent(),'Loading global avatar settings…');
  assert.equal(await page.locator('#avatar-generate-all').isDisabled(),true,'pending apply must not generate with the old vector selection');
  applyResponse.release();await waitForGlobalSelection(page,'theme-image',2);
  assert.equal(await page.locator('#avatar-generate-all').isDisabled(),false,'image generation is enabled despite disconnected SIWC');
  const batchResponse=page.waitForResponse(response=>response.url().endsWith('/v1/avatar-generations')&&response.status()===202);
  await page.locator('#avatar-generate-all').click();await batchResponse;await page.waitForFunction(()=>!!window.__avatarConfirmation);
  assert.match(await page.evaluate(()=>window.__avatarConfirmation),/exactly 2 images for 2 bots/i);assert.match(await page.evaluate(()=>window.__avatarConfirmation),/COST UNKNOWN/i);
  const batch=calls.find(call=>call.path==='/v1/avatar-generations').body;assert.equal(batch.expectedThemeId,'theme-image');assert.equal(batch.expectedRevision,2);assert.equal(batch.confirmedCount,2);assert.equal(batch.acknowledgeApiBilling,true);assert.equal(typeof batch.operationId,'string');
  await page.close();
 }finally{applyResponse.release();await browser.close();await fixture.close();}
});

test('vector avatars use authenticated Blob images, preserve stale revisions and keep uncertain admission IDs', async () => {
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const themes=['paper','angular'].map(id=>({id,name:id,kind:'vector',prompt:'Transparent geometric character, no circular frame',model:'gpt-6.1-sol',createdAt:'2026-10-01T00:00:00.000Z'}));
 let selection={themeId:'paper',revision:1},jobs=[];
 const avatars=[{botId:BOT_A,themeId:'paper',revision:1,status:'ready',artifactId:'one',mimeType:'image/svg+xml',updatedAt:'2026-10-01T00:00:00.000Z'}];
 const calls=[],images=[],applyResponse=responseGate();
 const settings=()=>({themes,selection,avatars,jobs});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  await page.route('**/v1/avatar-settings',async route=>{
   const req=route.request();if(req.method()==='PUT'){selection={themeId:req.postDataJSON().themeId,revision:2};avatars[0].status='obsolete';await applyResponse.hold();}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(settings())});
  });
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:'gpt-6.1-sol',name:'Text model'}],imageModels:[],imageAvailable:false})}));
  await page.route('**/v1/bots/*/avatar',async route=>{images.push(route.request().headers());await route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M10 10L90 10L50 90Z" fill="#abc"/></svg>'});});
  await page.route('**/v1/avatar-generations',async route=>{
   const body=route.request().postDataJSON();calls.push(body);
   if(calls.length===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'storage_unavailable',message:'Receipt could not be confirmed.'}})});return;}
   jobs=[{id:'new-job',operationId:body.operationId,botId:body.botId||BOT_A,...selection,status:'interrupted',error:{code:'avatar_generation_interrupted',message:'Outcome is unconfirmed.'},createdAt:'2026-10-01T00:00:01.000Z',updatedAt:'2026-10-01T00:00:01.000Z'}];
   await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({jobs})});
  });
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('.bot-item .timber-avatar-image').first().waitFor({state:'visible'});
  assert.match(await page.locator('.bot-item .timber-avatar-image').first().getAttribute('src'),/^blob:/);
  assert.equal(await page.locator('.bot-item .avatar-vector').first().evaluate(node=>getComputedStyle(node).borderRadius),'0px');
  assert.equal(images[0]['x-timber-client'],'console');assert.equal(images[0].authorization,undefined);
  await page.locator('#settings-button').click();
  await page.locator('#avatar-generate-all').click();
  await page.getByRole('button',{name:'Check / resend safely'}).waitFor({state:'visible'});
  await page.getByRole('button',{name:'Check / resend safely'}).click();
  await page.locator('.avatar-interrupted-warning').waitFor({state:'visible'});
  assert.equal(calls.length,2);assert.equal(calls[0].operationId,calls[1].operationId);
  assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].expectedThemeId,'paper');assert.equal(calls[0].expectedRevision,1);assert.deepEqual(Object.keys(calls[0]),['operationId','expectedThemeId','expectedRevision']);
  const prior=await page.locator('#avatar-bot-list .timber-avatar-image').getAttribute('src');
  await page.locator('#avatar-theme-select').selectOption('angular');await page.locator('#avatar-apply-theme').click();
  await applyResponse.entered;
  assert.equal(await page.locator('#avatar-status').textContent(),'Loading global avatar settings…');
  await page.locator('#avatar-bot-list .timber-avatar-image').waitFor({state:'visible'});
  assert.equal(await page.locator('#avatar-bot-list .avatar-stale').count(),0,'visible old image alone does not acknowledge the theme switch');
  assert.equal(await page.locator('#avatar-bot-list .timber-avatar-image').getAttribute('src'),prior,'loading retains the validated Blob');
  applyResponse.release();await waitForGlobalSelection(page,'angular',2);
  await page.locator('#avatar-bot-list .timber-avatar-image').waitFor({state:'visible'});
  assert.equal(await page.locator('#avatar-bot-list .avatar-stale').count(),1,'previous validated avatar remains visible and stale');
  assert.equal(await page.locator('#avatar-bot-list .timber-avatar-image').count(),1);
  assert.equal(await page.locator('#avatar-bot-list .timber-avatar-image').getAttribute('src'),prior,'theme switch retains the same validated Blob');
  assert.equal(await page.locator(`.bot-item[data-bot-id="${BOT_A}"] .timber-avatar-image`).getAttribute('src'),prior,'sidebar retains the same validated Blob');
  assert.equal(await page.locator(`.bot-item[data-bot-id="${BOT_A}"] .avatar-stale`).count(),1);
  await page.close();
 } finally {applyResponse.release();await browser.close();await fixture.close();}
});

test('PNG avatar display caches a 96px client thumbnail from authenticated image bytes',async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{window.__avatarBlobs=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.__avatarBlobs.push(blob);return create(blob);};});
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({themes:[{id:'png-theme',name:'PNG',kind:'image',prompt:'A small character',model:'gpt-image-2.5-sunburst'}],selection:{themeId:'png-theme',revision:1},avatars:[{botId:BOT_A,themeId:'png-theme',revision:1,status:'ready',artifactId:'png-one',mimeType:'image/png',updatedAt:'2026-10-01T00:00:00.000Z'}],jobs:[]})}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,vectorModels:[],imageModels:[],imageAvailable:false,imageBilling:{provider:'openai-api',separateFromChatGPT:true,costKnown:false,message:'Cost unknown'}})}));
  await page.route('**/v1/bots/*/avatar',route=>route.fulfill({status:200,contentType:'image/png',body:png}));
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('.bot-item .timber-avatar-image').first().waitFor({state:'visible'});
  const dimensions=await page.evaluate(async()=>{const blob=window.__avatarBlobs.at(-1);const bitmap=await createImageBitmap(blob);const value={width:bitmap.width,height:bitmap.height,type:blob.type};bitmap.close();return value;});
  assert.deepEqual(dimensions,{width:96,height:96,type:'image/png'});
  await page.close();
 }finally{await browser.close();await fixture.close();}
});

test('replacement failures retain decoded avatars across Settings renders and superseded URLs are bounded',async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 let artifact='one',fail=false;
 const settings=()=>({themes:[{id:'paper',name:'Paper',kind:'vector',model:'gpt-6.1-sol',prompt:'Geometry'}],selection:{themeId:'paper',revision:1},avatars:[{botId:BOT_A,themeId:'paper',revision:1,status:'ready',artifactId:artifact,mimeType:'image/svg+xml',updatedAt:'2026-10-01T00:00:00.000Z'}],jobs:[]});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{window.__avatarCreated=[];window.__avatarRevoked=[];const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);window.__avatarCreated.push(url);return url;};URL.revokeObjectURL=url=>{window.__avatarRevoked.push(url);revoke(url);};});
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(settings())}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:'gpt-6.1-sol',name:'Text'}],imageModels:[],imageAvailable:false})}));
  await page.route('**/v1/bots/*/avatar',route=>fail?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'storage_unavailable',message:'Could not read replacement.'}})}):route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M10 10L90 10L50 90Z" fill="#abc"/></svg>'}));
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  const sidebar=page.locator(`.bot-item[data-bot-id="${BOT_A}"] .timber-avatar-image`);
  await sidebar.waitFor({state:'visible'});const original=await sidebar.getAttribute('src');
  await page.locator('#settings-button').click();await page.locator('#avatar-bot-list .timber-avatar-image').waitFor({state:'visible'});
  artifact='two';fail=true;await page.locator('#avatar-refresh').click();
  await page.getByText('Could not load avatar image. Refresh to try again.',{exact:true}).waitFor({state:'visible'});
  assert.equal(await sidebar.getAttribute('src'),original);
  assert.equal(await page.locator('#avatar-bot-list .timber-avatar-image').getAttribute('src'),original);
  assert.equal(await page.evaluate(url=>window.__avatarRevoked.includes(url),original),false);
  fail=false;
  for(const next of ['two','three','four']){
   const previous=await sidebar.getAttribute('src');artifact=next;await page.locator('#avatar-refresh').click();
   await page.waitForFunction(({botId,previous})=>document.querySelector(`.bot-item[data-bot-id="${botId}"] .timber-avatar-image`)?.getAttribute('src')!==previous,{botId:BOT_A,previous});
   await page.waitForFunction(url=>window.__avatarRevoked.includes(url),previous);
   assert.equal(await page.evaluate(()=>window.__avatarCreated.filter(url=>!window.__avatarRevoked.includes(url)).length),1);
  }
  await page.locator('#disconnect').click();await page.locator('#login').waitFor({state:'visible'});
  assert.equal(await page.locator('.timber-avatar-image').count(),0);
  assert.equal(await page.evaluate(()=>window.__avatarCreated.filter(url=>!window.__avatarRevoked.includes(url)).length),0);
  await page.close();
 }finally{await browser.close();await fixture.close();}
});

for(const timing of ['before POST','before uncertain resend'])test(`image consent snapshot survives a switch ${timing} and requires fresh confirmation`,async()=>{
 const fixture=await createConsoleFixture();
 const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const themes=[
  {id:'sunburst-theme',name:'Sunburst shared',kind:'image',prompt:'Shared style',model:'gpt-image-2.5-sunburst',createdAt:'2026-10-01T00:00:00.000Z'},
  {id:'flare-theme',name:'Flare shared',kind:'image',prompt:'Shared style',model:'gpt-image-2.5-flare',createdAt:'2026-10-01T00:00:00.000Z'},
 ];
 let selection={themeId:'sunburst-theme',revision:1};const calls=[],accepted=[];
 const settings=()=>({themes,selection:{...selection},avatars:[],jobs:[]});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{window.__avatarConfirmations=[];window.confirm=message=>{window.__avatarConfirmations.push(message);return true;};});
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(settings())}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,vectorModels:[],imageModels:themes.map(theme=>({id:theme.model,name:theme.name,provider:'openai',billing:'openai-api'})),imageAvailable:true,imageBilling:{provider:'openai-api',separateFromChatGPT:true,costKnown:false,message:'Separately billed OpenAI API access, not ChatGPT.'}})}));
  await page.route('**/v1/avatar-generations',async route=>{
   const body=route.request().postDataJSON();calls.push(body);
   if(calls.length===1){
    selection={themeId:'flare-theme',revision:2};
    if(timing==='before uncertain resend'){
     // No admission receipt exists. The client must retain the original snapshot.
     await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'storage_unavailable',message:'Receipt could not be confirmed.'}})});return;
    }
   }
   if(body.expectedThemeId!==selection.themeId||body.expectedRevision!==selection.revision){
    await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'avatar_theme_changed',message:'The global theme changed since confirmation. Refresh and confirm the theme, count and billing again.'}})});return;
   }
   accepted.push(body);await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({jobs:[]})});
  });
  await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#settings-button').click();await page.locator('#avatar-generate-all').click();
  if(timing==='before uncertain resend'){
   await page.getByRole('button',{name:'Check / resend safely'}).waitFor({state:'visible'});
   await page.getByRole('button',{name:'Check / resend safely'}).click();
  }
  await page.waitForFunction(()=>document.getElementById('avatar-error').textContent.includes('global theme changed'));
  if(timing==='before uncertain resend')assert.deepEqual(calls[1],calls[0],'uncertain resend must not rewrite consent to Flare');
  assert.equal(calls[0].expectedThemeId,'sunburst-theme');assert.equal(calls[0].expectedRevision,1);
  assert.equal(accepted.length,0,'stale Sunburst consent must never be admitted for Flare');
  assert.equal(await page.getByRole('button',{name:'Check / resend safely'}).count(),0,'409 clears the rejected operation');
  assert.equal(await page.locator('#avatar-theme-select').inputValue(),'flare-theme','refresh after rejection exposes current global selection');
  assert.equal((await page.evaluate(()=>window.__avatarConfirmations)).length,1,'resend never prompts for or substitutes fresh consent');
  const acceptedResponse=page.waitForResponse(response=>response.url().endsWith('/v1/avatar-generations')&&response.status()===202);
  await page.locator('#avatar-generate-all').click();await acceptedResponse;await page.waitForFunction(()=>window.__avatarConfirmations.length===2);
  assert.equal(accepted.length,1);const fresh=accepted[0];assert.equal(fresh.expectedThemeId,'flare-theme');assert.equal(fresh.expectedRevision,2);
  assert.notEqual(fresh.operationId,calls[0].operationId);assert.equal(fresh.confirmedCount,2);assert.equal(fresh.acknowledgeApiBilling,true);
  const confirmations=await page.evaluate(()=>window.__avatarConfirmations);assert.match(confirmations[0],/gpt-image-2.5-sunburst/);assert.match(confirmations[1],/gpt-image-2.5-flare/);
 }finally{await browser.close();await fixture.close();}
});

// Avatar current-status and retained attempt history regressions.
const theme={id:'paper',name:'Paper',kind:'vector',prompt:'Angular geometry',model:'gpt-6.1-sol'};
function job(id,botId,status,index,extra={}){
 const createdAt=new Date(Date.UTC(2026,9,1,0,0,index)).toISOString();
 return {id,botId,status,operationId:`operation-${id}`,themeId:'paper',revision:1,createdAt,updatedAt:createdAt,...extra};
}
async function openSettings(page,fixture,mobile){
 await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
 if(mobile&&await page.locator('#mobile-back').isVisible())await page.locator('#mobile-back').click();
 await page.locator('#settings-button').click();await page.waitForFunction(()=>document.querySelector('#avatar-status').textContent==='Global selection · revision 1');
}
for(const mobile of [false,true])test(`avatar status bounds repeated attempts with separate accessible history (${mobile?'mobile':'desktop'})`,async()=>{
 const fixture=await createConsoleFixture(),browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 let jobs=Array.from({length:72},(_,i)=>job(`earlier-${i}`,i%2?BOT_A:BOT_B,i%3?'completed':'failed',i,{error:i%3?undefined:{message:'Historical avatar response did not contain completed text'}})).reverse();
 const calls=[],errors=[];
 try{
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({themes:[theme],selection:{themeId:'paper',revision:1},avatars:[],jobs})}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:theme.model}],imageModels:[],imageAvailable:false})}));
  await page.route('**/v1/avatar-generations',async route=>{
   const body=route.request().postDataJSON();calls.push(body);const targets=body.botId?[body.botId]:[BOT_A,BOT_B],incoming=targets.map((botId,i)=>job(`accepted-${calls.length}-${i}`,botId,'queued',100+calls.length*100,{operationId:body.operationId}));jobs=[...incoming,...jobs];
   await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({jobs:incoming})});
  });
  await openSettings(page,fixture,mobile);
  const current=page.locator('#avatar-current-jobs > .avatar-current-job'),history=page.locator('#avatar-job-history');
  assert.equal(await current.count(),2);assert.equal(await history.getAttribute('open'),null);assert.equal(await page.locator('#avatar-job-history .avatar-job').count(),10);assert.equal(await history.getByRole('button',{name:/Retry|Regenerate/}).count(),0);
  await history.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await history.evaluate(node=>node.open),true);assert.ok((await history.locator('summary').boundingBox()).height>=44);
  assert.match(await history.textContent(),/Earlier attempt · Paper · revision 1/);assert.match(await history.textContent(),/attempt earlier-/);assert.match(await history.locator('time').first().getAttribute('datetime'),/^2026-10-01T/);assert.ok(await history.locator('time').first().getAttribute('aria-label'),'timestamps expose the local timezone to assistive technology');
  await history.getByRole('button',{name:'Next attempts',exact:true}).click();assert.match(await history.textContent(),/Page 2 of 7/);assert.equal(await history.locator('.avatar-job').count(),10);
  for(let pageNumber=3;pageNumber<=7;pageNumber++)await history.getByRole('button',{name:'Next attempts',exact:true}).click();
  assert.match(await history.textContent(),/Page 7 of 7/);assert.equal(await history.getByRole('button',{name:'Next attempts',exact:true}).isDisabled(),true);assert.equal(await history.getByRole('button',{name:'Previous attempts',exact:true}).evaluate(node=>node===document.activeElement),true,'last-page navigation retains keyboard focus on an enabled control');
  await history.locator('summary').click();
  // Repeated full batches and retries never add another current row for a bot.
  for(let round=0;round<3;round++){
   await page.locator('#avatar-generate-all').click();await page.waitForFunction(()=>document.querySelectorAll('#avatar-current-jobs > [data-job-status="queued"]').length===2);
   assert.equal(await current.count(),2);assert.equal(await current.getByRole('button',{name:/Retry/}).count(),0);
   jobs=jobs.map(item=>item.id.startsWith(`accepted-${calls.length}-`)?{...item,status:'completed'}:item);await page.locator('#avatar-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('#avatar-current-jobs > [data-job-status="completed"]').length===2);
  }
  jobs.unshift(job('latest-failure',BOT_A,'failed',450,{error:{message:'Existing generation failed'}}));await page.locator('#avatar-refresh').click();await page.locator('#avatar-current-jobs > [data-job-id="latest-failure"]').waitFor();
  await current.getByRole('button',{name:'Retry avatar for Ada, revision 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#avatar-current-jobs > [data-job-status="queued"]'));
  assert.equal(calls.at(-1).botId,BOT_A);assert.equal(calls.at(-1).expectedRevision,1);assert.equal(calls.at(-1).expectedThemeId,'paper');assert.equal(new Set(calls.map(body=>body.operationId)).size,calls.length);assert.equal(await current.count(),2);
  // Late terminal updates never beat newer created success. Multiple genuine
  // active jobs, even older than that success, remain truthfully inspectable.
  jobs=[job('newer-success',BOT_A,'completed',1000),job('late-old-failure',BOT_A,'failed',800,{updatedAt:'2026-10-10T00:00:00.000Z',error:{message:'Old failure updated late'}}),job('newer-linus-success',BOT_B,'completed',900),job('active-one',BOT_B,'running',1),job('active-two',BOT_B,'queued',2),...jobs.filter(item=>!['queued','running'].includes(item.status))];
  await page.locator('#avatar-refresh').click();await page.locator('#avatar-current-jobs > [data-job-id="newer-success"]').waitFor();
  assert.equal(await current.first().getAttribute('data-bot-id'),BOT_B);assert.equal(await current.count(),2);assert.equal(await current.getByRole('button',{name:/Retry/}).count(),0);assert.match(await current.first().textContent(),/2 active attempts · 1 running, 1 queued/);
  assert.equal(await page.locator('.avatar-active-attempts .avatar-job').count(),0,'closed active details do not mount hidden attempt rows');await current.getByText('Inspect all 2 active attempts',{exact:true}).click();await page.locator('.avatar-active-attempts [data-job-status="running"]').waitFor({state:'visible'});assert.equal(await page.locator('.avatar-active-attempts [data-job-status="running"]').isVisible(),true);assert.equal(await page.locator('.avatar-active-attempts [data-job-status="queued"]').isVisible(),true);assert.match(await page.locator('.avatar-active-attempts').textContent(),/attempt active-one/);
  await history.locator('summary').click();assert.equal(await history.getByRole('button',{name:/Retry|Regenerate/}).count(),0);
  const geometry=await page.evaluate(()=>{const modal=document.querySelector('#settings-dialog');return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,width:modal.clientWidth,scrollWidth:modal.scrollWidth};});assert.ok(geometry.documentWidth<=geometry.viewport);assert.ok(geometry.scrollWidth<=geometry.width);assert.deepEqual(errors,[]);
 }finally{await browser.close();await fixture.close();}
});

test('Retry rechecks exact failed job and revision, suppressing stale failures without inference',async()=>{
 const fixture=await createConsoleFixture(),browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 let jobs=[job('failed-current',BOT_A,'failed',1)],selection={themeId:'paper',revision:1},getError=false,imageMode=false;const calls=[];
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  await page.route('**/v1/avatar-settings',route=>route.fulfill({status:getError?503:200,contentType:'application/json',body:JSON.stringify(getError?{error:{message:'Status refresh unavailable'}}:{themes:[imageMode?{...theme,id:'image-paper',kind:'image',model:'gpt-image-2.5-sunburst'}:theme],selection,avatars:[],jobs})}));
  await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:theme.model}],imageModels:imageMode?[{id:'gpt-image-2.5-sunburst'}]:[],imageAvailable:imageMode,imageBilling:{costKnown:false,message:'Separately billed OpenAI API access, not ChatGPT.'}})}));
  await page.route('**/v1/avatar-generations',route=>{calls.push(route.request().postDataJSON());return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({jobs:[]})});});
  await openSettings(page,fixture,false);
  const retry=page.getByRole('button',{name:'Retry avatar for Ada, revision 1',exact:true});
  getError=true;await retry.click();await page.getByText('Status refresh unavailable',{exact:true}).waitFor();assert.equal(calls.length,0,'failed refresh cannot authorize a retry');getError=false;
  jobs.unshift(job('newer-active',BOT_A,'running',2));await retry.click();await page.getByText('This avatar attempt is no longer current. Review the refreshed status before regenerating.',{exact:true}).waitFor();assert.equal(calls.length,0);assert.equal(await retry.count(),0);
  jobs=[job('failed-new',BOT_A,'failed',3)];selection={themeId:'paper',revision:2};await page.locator('#avatar-refresh').click();await page.waitForFunction(()=>document.querySelector('#avatar-status').textContent==='Global selection · revision 2');assert.equal(await page.locator('#avatar-current-jobs').getByRole('button',{name:/Retry/}).count(),0,'a failure from an earlier revision is not retryable');assert.match(await page.locator('#avatar-current-jobs').textContent(),/previous selection/);
  // A theme change between the displayed failure and passive retry check is
  // rejected too, with no substitution of the new revision into old Retry.
  jobs=[job('failed-new',BOT_A,'failed',3,{revision:2})];await page.locator('#avatar-refresh').click();const revisionTwo=page.getByRole('button',{name:'Retry avatar for Ada, revision 2',exact:true});await revisionTwo.waitFor();selection={themeId:'paper',revision:3};await revisionTwo.click();await page.getByText('This avatar attempt is no longer current. Review the refreshed status before regenerating.',{exact:true}).waitFor();assert.equal(calls.length,0);
  // A current image failure still needs fresh, exact one-image billing consent.
  imageMode=true;selection={themeId:'image-paper',revision:4};jobs=[job('image-failure',BOT_A,'failed',4,{themeId:'image-paper',revision:4})];await page.locator('#avatar-refresh').click();const imageRetry=page.getByRole('button',{name:'Retry avatar for Ada, revision 4',exact:true});await imageRetry.waitFor();
  await page.evaluate(()=>{window.__avatarRetryConfirmations=[];window.confirm=message=>{window.__avatarRetryConfirmations.push(message);return false;};});await imageRetry.click();await page.waitForFunction(()=>window.__avatarRetryConfirmations.length===1);assert.equal(calls.length,0,'declined image consent admits no generation');
  await page.evaluate(()=>{window.confirm=message=>{window.__avatarRetryConfirmations.push(message);return true;};});const admitted=page.waitForResponse(response=>response.url().endsWith('/v1/avatar-generations')&&response.status()===202);await imageRetry.click();await admitted;assert.equal(calls.length,1);assert.equal(calls[0].expectedThemeId,'image-paper');assert.equal(calls[0].expectedRevision,4);assert.equal(calls[0].confirmedCount,1);assert.equal(calls[0].acknowledgeApiBilling,true);assert.equal(calls[0].botId,BOT_A);assert.match(await page.evaluate(()=>window.__avatarRetryConfirmations.at(-1)),/exactly 1 image.*1 bot/);
 }finally{await browser.close();await fixture.close();}
});
