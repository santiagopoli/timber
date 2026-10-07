import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});});
after(async()=>{await browser?.close();});
const text='const message: string = "hello";\nconsole.log(message);';
const projects=[{path:'frontend',name:'frontend',branch:'feature/preview',head:'abcdef123',detached:false,dirty:true,staged:1,unstaged:1,untracked:1},{path:'backend',name:'backend',branch:'main',head:'123abcdef',detached:false,dirty:false,staged:0,unstaged:0,untracked:0}];
async function withWorkspace(work,{width=1440}={}) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:1050}}),page=await context.newPage();
 const errors=[],violations=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__workspaceCsp',v=>violations.push(v));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>globalThis.__workspaceCsp({directive:e.effectiveDirective,resource:e.blockedURI})));
 await page.route('**/v1/bots/*/workspace/**',async route=>{
  const url=new URL(route.request().url());calls.push(url.pathname+url.search);
  assert.equal(route.request().headers().authorization,`Bearer ${TEST_TOKEN}`);
  const path=url.searchParams.get('path'),endpoint=url.pathname.split('/').at(-1);
  const json=data=>route.fulfill({json:data});
  if(endpoint==='projects')return json({projects,truncated:false});
  if(endpoint==='tree')return json({path:path||'.',entries:path==='frontend'?[{name:'app.ts',path:'frontend/app.ts',kind:'file',size:52,accessible:true},{name:'unsafe.html',path:'frontend/unsafe.html',kind:'file',size:45,accessible:true},{name:'data.bin',path:'frontend/data.bin',kind:'file',size:3,accessible:true}]:[{name:'frontend',path:'frontend',kind:'directory',size:0,accessible:true},{name:'backend',path:'backend',kind:'directory',size:0,accessible:true},{name:'outside',path:'outside',kind:'symlink',size:0,accessible:false}],truncated:false});
  if(endpoint==='file')return json({path,name:path.split('/').at(-1),size:52,mimeType:path.endsWith('.bin')?'application/octet-stream':'text/plain',kind:path.endsWith('.bin')?'binary':'text',content:path.endsWith('unsafe.html')?'<script>globalThis.__unsafeExecuted=true</script>':text,language:path.endsWith('.html')?'html':'typescript',truncated:false,downloadable:true});
  if(endpoint==='changes')return json({project:'frontend',changes:[{path:'app.ts',indexStatus:'M',worktreeStatus:'M',staged:true,unstaged:true,untracked:false},{path:'new.ts',indexStatus:'?',worktreeStatus:'?',staged:false,unstaged:false,untracked:true}],truncated:false});
  if(endpoint==='diff')return json({project:'frontend',path,mode:url.searchParams.get('mode'),diff:'--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new',truncated:false,binary:false});
  if(endpoint==='download')return route.fulfill({body:Buffer.from([0,1,2]),headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="data.bin"'}});
  return route.fulfill({status:404,json:{error:{message:'Unknown fixture endpoint'}}});
 });
 const login=async()=>{await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#bot-workspace').waitFor({state:'visible'});};
 try {await work({page,login,calls,context});assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);}
 finally{await context.close();await fixture.close();}
}
test('workspace browser opens highlighted code, safely displays HTML and downloads binary files',async()=>{
 await withWorkspace(async({page,login,calls})=>{
  await login();assert.equal(calls.length,0,'hidden Files does not wake the computer');
  await page.locator('#tab-files').click();await page.locator('.workspace-project').filter({hasText:'feature/preview'}).waitFor();
  assert.equal(await page.locator('.workspace-project').count(),2);
  assert.equal(await page.getByRole('button',{name:'outside ↗'}).isDisabled(),true);
  await page.locator('.workspace-entry').filter({hasText:'frontend'}).click();
  await page.locator('.workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
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
  await login();await page.locator('#tab-files').click();
  await page.locator('.workspace-project').filter({hasText:'feature/preview'}).click();
  await page.locator('.workspace-changes .workspace-entry').filter({hasText:'app.ts'}).click();
  await page.locator('.workspace-diff').filter({hasText:'+new'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Working changes',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Staged changes',exact:true}).click();
  await page.locator('.workspace-diff').filter({hasText:'+new'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Staged changes',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('.workspace-source').filter({hasText:'const message'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.CONSOLE_SCREENSHOT_DIR){await mkdir(process.env.CONSOLE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.CONSOLE_SCREENSHOT_DIR}/workspace-files-mobile.png`,fullPage:true});}
  await page.locator(`[data-bot-id="${BOT_B}"]`).click();await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();
  assert.equal(await page.locator('.workspace-source').count(),0,'switching bots removes old source');
 },{width:390});
});
