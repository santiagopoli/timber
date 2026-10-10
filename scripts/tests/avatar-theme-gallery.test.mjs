import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {builtinAvatarThemes} from '../../packages/contracts/src/avatar-presets.ts';
import {createConsoleFixture,TEST_TOKEN,BOT_A} from './console-fixture.mjs';

for(const [name,viewport] of [['desktop',{width:1280,height:1000}],['mobile',{width:390,height:844}]])test(`built-in theme gallery: ${name}`,async()=>{
  const fixture=await createConsoleFixture();
  const browser=await chromium.launch({executablePath:process.env.CONSOLE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const themes=builtinAvatarThemes();let selection={themeId:themes[0].id,revision:1};
  const calls=[],errors=[],assetFailures=[];let rejectReasoningOnce=false;
  const settings=()=>({themes,selection,avatars:[{botId:BOT_A,themeId:themes[0].id,revision:1,status:'ready',artifactId:'gallery-owl',mimeType:'image/svg+xml',updatedAt:'2026-10-10T00:00:00Z'}],jobs:[]});
  try{
    const page=await browser.newPage({viewport,deviceScaleFactor:2,colorScheme:name==='desktop'?'dark':'light',isMobile:name==='mobile',hasTouch:name==='mobile'});
    page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    page.on('response',response=>{if(response.url().includes('/avatar-themes/')&&!response.ok())assetFailures.push(response.url());});
    await page.route('**/v1/avatar-settings',async route=>{
      if(route.request().method()==='PUT'){const body=route.request().postDataJSON();calls.push({path:'selection',body});selection={themeId:body.themeId,revision:selection.revision+1};}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(settings())});
    });
    await page.route('**/v1/avatar-models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:true,vectorModels:[{id:'gpt-6.1-sol',name:'GPT-6.1',reasoningEfforts:['medium','high'],defaultReasoningEffort:'medium'},{id:'fixed-model',name:'No reasoning options',reasoningEfforts:[]}],imageModels:[],imageAvailable:false})}));
    await page.route('**/v1/bots/*/avatar',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M32 32L64 44L96 32L96 80L64 108L32 80Z" fill="#ad794d"/></svg>'}));
    await page.route('**/v1/avatar-generations',async route=>{calls.push({path:'generation'});await route.fulfill({status:202,contentType:'application/json',body:'{"jobs":[]}'});});
    await page.route('**/v1/avatar-themes',async route=>{
      if(route.request().method()==='PATCH'){
        const body=route.request().postDataJSON();calls.push({path:'reasoning',body});const theme=themes.find(theme=>theme.id===body.themeId);
        if(rejectReasoningOnce){rejectReasoningOnce=false;theme.reasoningEffort='medium';await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'avatar_theme_changed',message:'The theme reasoning changed. Refresh before saving.'}})});return;}
        assert.equal(body.expectedReasoningEffort,theme.reasoningEffort??null);
        if(body.reasoningEffort===null)delete theme.reasoningEffort;else theme.reasoningEffort=body.reasoningEffort;
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({theme})});return;
      }
      const body=route.request().postDataJSON();calls.push({path:'theme',body});const theme={...body,id:crypto.randomUUID(),framing:'circle'};themes.push(theme);
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({theme})});
    });
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
    await page.locator('#settings-button').click();await page.waitForFunction(()=>document.getElementById('avatar-theme-select').options.length===11);
    await page.locator('.avatar-collection-details>summary').click();
    const cards=page.locator('.avatar-theme-card');assert.equal(await cards.count(),10);assert.equal(await cards.locator('img').count(),50);
    const evidence=process.env.AVATAR_THEME_EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true});
    for(const card of await cards.all()){
      await card.scrollIntoViewIfNeeded();await page.waitForFunction(slug=>[...document.querySelectorAll(`[data-theme-preset="${slug}"] img`)].every(image=>image.dataset.framed==='true'&&image.complete&&image.naturalWidth>0),await card.getAttribute('data-theme-preset'));
      if(evidence&&name==='desktop')await card.screenshot({path:`${evidence}/${await card.getAttribute('data-theme-preset')}.png`});
    }
    if(evidence&&name==='desktop')await writeFile(`${evidence}/layout.json`,JSON.stringify(await cards.locator('img').evaluateAll(images=>images.map(image=>({name:image.alt,style:image.getAttribute('style'),size:[image.naturalWidth,image.naturalHeight],computed:{width:getComputedStyle(image).width,height:getComputedStyle(image).height,maxHeight:getComputedStyle(image).maxHeight,transform:getComputedStyle(image).transform,margin:getComputedStyle(image).margin},rect:image.getBoundingClientRect().toJSON(),parent:image.parentElement.getBoundingClientRect().toJSON()}))),null,2));
    const vectorCenters=await page.locator('[data-kind="vector"] img').evaluateAll(images=>images.map(image=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const context=canvas.getContext('2d');context.drawImage(image,0,0,256,256);
      const data=context.getImageData(0,0,256,256).data;let left=256,top=256,right=0,bottom=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++)if(data[(y*256+x)*4+3]>=128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      const scale=parseFloat(image.style.width)/100,dx=parseFloat(image.style.left)/100,dy=parseFloat(image.style.top)/100;let radius=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++)if(data[(y*256+x)*4+3]>=128)radius=Math.max(radius,Math.hypot(dx+(x+.5)/256*scale-.5,dy+(y+.5)/256*scale-.5));
      return {name:image.alt,x:dx+(left+right+1)/512*scale,y:dy+(top+bottom+1)/512*scale,radius};
    }));
    for(const center of vectorCenters){assert.ok(Math.abs(center.x-.5)<.005,JSON.stringify(center));assert.ok(Math.abs(center.y-.5)<.005,JSON.stringify(center));assert.ok(center.radius<.441,JSON.stringify(center));}
    const geometry=await page.locator('#settings-dialog').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,page:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));assert.ok(geometry.page<=geometry.viewport+1,JSON.stringify(geometry));
    const watercolor=page.locator('[data-theme-preset="watercolor"]');await watercolor.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#avatar-theme-select').inputValue(),themes[8].id);assert.equal(await watercolor.getAttribute('aria-pressed'),'true');
    assert.equal(calls.length,0,'browsing is free and must not apply a theme or generate');
    await page.locator('#avatar-refresh').click();await page.waitForFunction(()=>document.getElementById('avatar-status').textContent==='Global selection · revision 1');
    assert.equal(await page.locator('#avatar-theme-select').inputValue(),themes[8].id,'refresh must retain an unapplied gallery selection');
    await page.locator('#avatar-apply-theme').click();await page.waitForFunction(()=>document.getElementById('avatar-status').textContent.includes('revision 2'));
    assert.equal(calls.length,1);assert.equal(calls[0].path,'selection');assert.equal(await page.locator('#avatar-generate-all').isDisabled(),true,'saving an image preset does not claim generation is configured');
    const old=page.locator('#avatar-bot-list .avatar-head');await old.locator('img').waitFor({state:'visible'});
    assert.deepEqual(await old.evaluate(n=>{const s=getComputedStyle(n);return {radius:s.borderRadius,fit:getComputedStyle(n.querySelector('img')).objectFit,opaque:!['transparent','rgba(0, 0, 0, 0)'].includes(s.backgroundColor)};}),{radius:'50%',fit:'contain',opaque:true});
    await page.locator('#avatar-create-details>summary').click();await page.locator('#avatar-theme-name').fill('Watercolor Animals');await page.locator('#avatar-theme-prompt').fill('Watercolor washes');await page.locator('#avatar-theme-subject').fill('Animals');await page.locator('#avatar-create-submit').click();
    await page.waitForFunction(()=>document.getElementById('avatar-theme-name').value==='');assert.deepEqual({...calls.at(-1).body,operationId:undefined},{name:'Watercolor Animals',kind:'vector',style:'Watercolor washes',subject:'Animals',model:'gpt-6.1-sol',operationId:undefined});
    await page.locator('#avatar-theme-name').fill('Free watercolor');await page.locator('#avatar-theme-prompt').fill('Watercolor washes');await page.locator('#avatar-create-submit').click();
    await page.waitForFunction(()=>document.getElementById('avatar-theme-name').value==='');assert.equal(calls.at(-1).body.subject,undefined);
    // Editing the theme changes future generation preferences without applying
    // a theme, modifying bot settings or admitting an inference request.
    await page.locator('#avatar-theme-select').selectOption(themes[0].id);
    assert.equal(await page.locator('#avatar-reasoning-field').isVisible(),true);
    assert.deepEqual(await page.locator('#avatar-reasoning-select option').allTextContents(),['Model default · medium','Medium','High']);
    await page.locator('#avatar-reasoning-select').selectOption('high');
    await page.locator('#avatar-refresh').click();await page.waitForFunction(()=>!document.getElementById('avatar-theme-select').disabled);
    assert.equal(await page.locator('#avatar-reasoning-select').inputValue(),'high','refresh must preserve unsaved reasoning');
    await page.locator('#avatar-save-reasoning').click();await page.waitForFunction(()=>document.getElementById('avatar-reasoning-status').textContent.includes('Saved'));
    assert.equal(calls.at(-1).path,'reasoning');assert.equal(calls.at(-1).body.reasoningEffort,'high');assert.equal(calls.at(-1).body.expectedReasoningEffort,null);
    await page.locator('#avatar-refresh').click();await page.waitForFunction(()=>!document.getElementById('avatar-theme-select').disabled);
    assert.equal(await page.locator('#avatar-reasoning-select').inputValue(),'high');
    if(evidence){await page.locator('#avatar-reasoning-field').scrollIntoViewIfNeeded();await page.locator('#avatar-reasoning-field').screenshot({path:`${evidence}/reasoning-${name}.png`});}
    await page.locator('#avatar-theme-select').selectOption(themes[1].id);assert.equal(await page.locator('#avatar-reasoning-select').inputValue(),'');
    await page.locator('#avatar-theme-select').selectOption(themes[0].id);assert.equal(await page.locator('#avatar-reasoning-select').inputValue(),'high');
    await page.locator('#avatar-reasoning-select').selectOption('');await page.locator('#avatar-save-reasoning').click();await page.waitForFunction(()=>document.getElementById('avatar-reasoning-status').textContent.includes('Saved'));
    assert.equal(calls.at(-1).body.reasoningEffort,null);assert.equal(calls.at(-1).body.expectedReasoningEffort,'high');
    rejectReasoningOnce=true;await page.locator('#avatar-reasoning-select').selectOption('high');await page.locator('#avatar-save-reasoning').click();
    await page.waitForFunction(()=>document.getElementById('avatar-error').textContent.includes('reasoning changed'));
    assert.equal(await page.locator('#avatar-reasoning-select').inputValue(),'medium','a stale edit must show the latest saved preference');
    await page.locator('#avatar-reasoning-select').selectOption('high');await page.locator('#avatar-save-reasoning').click();await page.waitForFunction(()=>document.getElementById('avatar-reasoning-status').textContent.includes('Saved'));
    assert.equal(calls.at(-1).body.expectedReasoningEffort,'medium');
    await page.locator('#avatar-theme-select').selectOption(themes[8].id);assert.equal(await page.locator('#avatar-reasoning-field').isVisible(),false);
    assert.equal(calls.filter(call=>call.path==='generation').length,0);
    await page.locator('#avatar-theme-name').fill('Careful SVG');await page.locator('#avatar-theme-prompt').fill('Paperfold');await page.locator('#avatar-theme-reasoning').selectOption('high');await page.locator('#avatar-create-submit').click();
    await page.waitForFunction(()=>document.getElementById('avatar-theme-name').value==='');assert.equal(calls.at(-1).body.reasoningEffort,'high');
    await page.locator('#avatar-theme-reasoning').selectOption('high');await page.locator('#avatar-theme-model').selectOption('fixed-model');assert.equal(await page.locator('#avatar-theme-reasoning').inputValue(),'');assert.equal(await page.locator('#avatar-theme-reasoning option').count(),1);
    await page.locator('#avatar-theme-kind').selectOption('image');assert.equal(await page.locator('#avatar-theme-reasoning-field').isVisible(),false);
    assert.equal(calls.filter(call=>call.path==='generation').length,0);assert.deepEqual(errors,[]);assert.deepEqual(assetFailures,[]);
    if(evidence){
      await page.locator('#avatar-create-details').evaluate(n=>n.open=false);await page.locator('#settings-dialog').evaluate(n=>n.scrollTop=0);await page.screenshot({path:`${evidence}/settings-${name}.png`});
      if(name==='desktop'){
        // Contact sheets use the same rendered gallery components and real
        // packaged artwork, isolated from the modal for a readable comparison.
        await page.locator('#avatar-theme-gallery img').evaluateAll(images=>images.forEach(image=>image.loading='eager'));
        await page.waitForFunction(()=>[...document.querySelectorAll('#avatar-theme-gallery img')].every(image=>image.dataset.framed==='true'&&image.complete&&image.naturalWidth>0));
        await page.evaluate(()=>{
          const gallery=document.getElementById('avatar-theme-gallery').cloneNode(true);document.getElementById('settings-dialog').close();
          const board=document.createElement('main');board.id='theme-proof';board.append(gallery);document.body.append(board);
        });
        await page.route('**/console/theme-evidence.css',route=>route.fulfill({contentType:'text/css',body:'body{overflow:auto;height:auto}body>*:not(#theme-proof){display:none!important}#theme-proof{width:840px;padding:36px;margin:auto;background:var(--bg)}#theme-proof .avatar-theme-gallery{gap:32px}#theme-proof .avatar-theme-group{gap:16px}#theme-proof .avatar-theme-card{padding:24px;gap:18px}#theme-proof .avatar-theme-samples{gap:28px}#theme-proof .avatar-theme-card-heading strong{font-size:21px}#theme-proof .avatar-theme-subject{font-size:15px}#theme-proof .avatar-theme-description{font-size:14px}#theme-proof .avatar-theme-group h4{font-size:16px;padding-bottom:12px}'}));await page.addStyleTag({url:'/console/theme-evidence.css'});
        for(const kind of ['vector','image']){
          await page.mouse.move(0,0);
          const group=page.locator(`#theme-proof [data-kind="${kind}"]`);await group.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));await group.screenshot({path:`${evidence}/${kind}-collection.png`});
        }
      }
    }
  }finally{await browser.close();await fixture.close();}
});
