import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';
let browser;
const openPanel=async(page,panel)=>{if(!await page.locator(`#tab-${panel}`).isVisible())await page.locator('#panel-menu > summary').click();await page.locator(`#tab-${panel}`).click();};
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});});
after(async()=>{await browser?.close();});
const text='const message: string = "hello";\nconsole.log(message);';
const projects=[{path:'frontend',name:'frontend',branch:'feature/preview',head:'abcdef123',detached:false,dirty:true,staged:1,unstaged:1,untracked:1},{path:'backend',name:'backend',branch:'main',head:'123abcdef',detached:false,dirty:false,staged:0,unstaged:0,untracked:0}];
async function withWorkspace(work,{width=1440,height=1050,largeFiles=false,colorScheme='light'}={}) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height},colorScheme}),page=await context.newPage();
 const errors=[],violations=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__workspaceCsp',v=>violations.push(v));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>globalThis.__workspaceCsp({directive:e.effectiveDirective,resource:e.blockedURI})));
 await page.route('**/v1/bots/*/workspace/**',async route=>{
  const url=new URL(route.request().url());calls.push(url.pathname+url.search);
  const headers=await route.request().allHeaders();assert.equal(headers.authorization,undefined);assert.equal(headers['x-timber-client'],'console');assert.match(headers.cookie||'',/timber_fixture_session=/);
  const path=url.searchParams.get('path'),endpoint=url.pathname.split('/').at(-1);
  const json=data=>route.fulfill({json:data});
  if(endpoint==='projects')return json({projects,truncated:false});
  if(endpoint==='tree')return json({path:path||'.',entries:path==='frontend'?[{name:'app.ts',path:'frontend/app.ts',kind:'file',size:52,accessible:true},{name:'unsafe.html',path:'frontend/unsafe.html',kind:'file',size:45,accessible:true},{name:'data.bin',path:'frontend/data.bin',kind:'file',size:3,accessible:true},...(largeFiles?Array.from({length:40},(_,n)=>({name:`module-${n}.ts`,path:`frontend/module-${n}.ts`,kind:'file',size:10000,accessible:true})):[])]:[{name:'frontend',path:'frontend',kind:'directory',size:0,accessible:true},{name:'backend',path:'backend',kind:'directory',size:0,accessible:true},{name:'outside',path:'outside',kind:'symlink',size:0,accessible:false}],truncated:false});
  if(endpoint==='file')return json({path,name:path.split('/').at(-1),size:52,mimeType:path.endsWith('.bin')?'application/octet-stream':'text/plain',kind:path.endsWith('.bin')?'binary':'text',content:path.endsWith('unsafe.html')?'<script>globalThis.__unsafeExecuted=true</script>':largeFiles?Array.from({length:100},(_,n)=>`const line${n} = "${'wide source '.repeat(30)}";`).join('\n'):text,language:path.endsWith('.html')?'html':'typescript',truncated:false,downloadable:true});
  if(endpoint==='changes')return json({project:'frontend',changes:[{path:'app.ts',indexStatus:'M',worktreeStatus:'M',staged:true,unstaged:true,untracked:false},{path:'new.ts',indexStatus:'?',worktreeStatus:'?',staged:false,unstaged:false,untracked:true}],truncated:false});
  if(endpoint==='diff')return json({project:'frontend',path,mode:url.searchParams.get('mode'),diff:'--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new',truncated:false,binary:false});
  if(endpoint==='download')return route.fulfill({body:Buffer.from([0,1,2]),headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="data.bin"'}});
  return route.fulfill({status:404,json:{error:{message:'Unknown fixture endpoint'}}});
 });
 const login=async()=>{await page.goto(fixture.url);await page.locator('#login').waitFor({state:'visible'});await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});if(width<=760)await page.locator('.bot-item').first().click();await page.locator('#bot-workspace').waitFor({state:'visible'});};
 try {await work({page,login,calls,context});assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);}
 finally{await context.close();await fixture.close();}
}
test('workspace browser opens highlighted code, safely displays HTML and downloads binary files',async()=>{
 await withWorkspace(async({page,login,calls})=>{
  await login();assert.equal(calls.length,0,'hidden Files does not wake the computer');
  await openPanel(page,'files');await page.locator('#expand-workspace').click();await page.locator('.workspace-project').filter({hasText:'feature/preview'}).waitFor();
  assert.equal(await page.locator('.workspace-project').count(),2);
  assert.equal(await page.getByRole('button',{name:'outside ↗'}).isDisabled(),true);
  await page.locator('.workspace-entry').filter({hasText:'frontend'}).click();
  await page.locator('.workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
  assert.equal(await page.locator('.workspace-sidebar').isVisible(),true,'desktop keeps the browser beside the file');
  assert.equal(await page.getByRole('button',{name:'Back to files',exact:true}).isVisible(),false);
  await page.waitForFunction(()=>document.querySelector('.workspace-source-line span[style]')?.style.color);
  assert.equal(await page.locator('.workspace-line-number').count(),2);
  await page.locator('.workspace-entry').filter({hasText:'unsafe.html'}).click();
  await page.locator('.workspace-source').filter({hasText:'<script>'}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.__unsafeExecuted),undefined);
  await page.locator('.workspace-entry').filter({hasText:'data.bin'}).click();
  await page.locator('.workspace-empty').filter({hasText:'application/octet-stream'}).waitFor();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download file',exact:true}).click();assert.equal((await downloaded).suggestedFilename(),'data.bin');
 });
});
test('multiple Git projects expose branch state and staged/working diffs on mobile',async()=>{
 await withWorkspace(async({page,login})=>{
  await login();await openPanel(page,'files');
  await page.locator('.workspace-project').filter({hasText:'feature/preview'}).click();
  await page.locator('.workspace-changes .workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-diff').filter({hasText:'+new'}).waitFor();
  assert.equal(await page.locator('.workspace-sidebar').isVisible(),false,'mobile dedicates the view to the selected diff');
  assert.equal(await page.getByRole('button',{name:'Working changes',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Staged changes',exact:true}).click();
  await page.locator('.workspace-diff').filter({hasText:'+new'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Staged changes',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
  await page.getByRole('button',{name:'Back to changes',exact:true}).click();
  assert.equal(await page.locator('.workspace-changes').isVisible(),true);
  await page.locator('.workspace-changes .workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-diff').filter({hasText:'+new'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/workspace-files-mobile.png`,fullPage:true});}
  await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_B}"]`).click();await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();
  assert.equal(await page.locator('.workspace-source').count(),0,'switching bots removes old source');
 },{width:390});
});

for(const width of [375,390])test(`mobile Files uses the full viewport and returns to the same folder at ${width}px`,async()=>{
 await withWorkspace(async({page,login})=>{
  await login();await openPanel(page,'files');
  const folder=page.locator('.workspace-file-list .workspace-entry').filter({hasText:'frontend'});
  await folder.waitFor();
  assert.equal(await page.locator('.workspace-viewer').isVisible(),false,'no empty preview stacked below the list');
  const alignment=await folder.evaluate(element=>({button:element.getBoundingClientRect().left,label:element.querySelector('span').getBoundingClientRect().left}));
  assert.ok(alignment.label-alignment.button<=44,'folder labels align beside the icon instead of in the center');
  const projectSize=await page.locator('.workspace-project').first().boundingBox();
  assert.ok(projectSize.height<=70,'project and branch fit in a compact two-line control');
  const header=await page.locator('.bot-header').boundingBox(),refresh=await page.getByRole('button',{name:'Refresh workspace',exact:true}).boundingBox();
  assert.ok(refresh.y>=header.y+header.height,'Refresh is below the conversation header');
  await folder.click();
  const lastFile=page.locator('.workspace-entry').filter({hasText:'module-39.ts'});
  await lastFile.scrollIntoViewIfNeeded();
  const before=await page.locator('.workspace-file-list').evaluate(element=>element.scrollTop);
  assert.ok(before>0,'the file list scrolls independently');
  assert.equal(await page.locator('#panel-files').evaluate(element=>element.scrollTop),0,'scrolling files cannot hide the toolbar');
  await lastFile.click();await page.locator('.workspace-source').filter({hasText:'const line99'}).waitFor();
  assert.equal(await page.locator('.workspace-sidebar').isVisible(),false);
  const codeBox=await page.locator('.workspace-code').boundingBox();
  assert.ok(codeBox.height>=600,'source gets the remaining screen height');
  const scroll=await page.locator('.workspace-code').evaluate(element=>{element.scrollLeft=200;element.scrollTop=300;return {x:element.scrollLeft,y:element.scrollTop};});
  assert.ok(scroll.x>0 && scroll.y>0,'wide, long source scrolls in the code pane');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'source cannot widen the document');
  if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/workspace-source-${width}.png`,fullPage:true});}
  await page.getByRole('button',{name:'Back to files',exact:true}).click();
  assert.equal(await page.locator('.workspace-viewer').isVisible(),false);
  assert.match(await page.locator('.workspace-breadcrumbs').textContent(),/frontend/);
  assert.ok(Math.abs(await page.locator('.workspace-file-list').evaluate(element=>element.scrollTop)-before)<2,'returning preserves list scroll');
  if(process.env.CONSOLE_SCREENSHOT_DIR){await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/workspace-browser-${width}.png`,fullPage:true});}
 },{width,height:844,largeFiles:true,colorScheme:width===375?'dark':'light'});
});

for (const width of [1440,820]) test(`docked Files preserves source while switching workspace panels at ${width}px`,async()=>{
 await withWorkspace(async({page,login,calls})=>{
  await login();await page.locator('#message').fill('Review this file');await openPanel(page,'files');
  await page.locator('.workspace-entry').filter({hasText:'frontend'}).click();
  await page.locator('.workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
  assert.equal(await page.locator('#panel-conversation').isVisible(),true);
  assert.equal(await page.locator('.workspace-sidebar').isVisible(),false,'the compact pane dedicates its width to the open source');
  const fileCalls=calls.filter(path=>path.includes('/file?')).length;
  await page.locator('.inspector-tabs [data-panel="computer"]').click();
  await page.locator('.inspector-tabs [data-panel="files"]').click();
  await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
  assert.equal(calls.filter(path=>path.includes('/file?')).length,fileCalls,'switching panels retains the selected file');
  assert.equal(await page.locator('#message').inputValue(),'Review this file');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/files-docked-${width}.png`});}
  await page.getByRole('button',{name:'Back to files',exact:true}).click();
  await page.locator('.workspace-entry').filter({hasText:'unsafe.html'}).waitFor();
 },{width,colorScheme:'dark'});
});
