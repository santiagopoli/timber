import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';

let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});});
after(async()=>{await browser?.close();});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const project={path:'spacetime',name:'spacetime',branch:'main',head:'abcdef123',detached:false,dirty:false,staged:0,unstaged:0,untracked:0};
const directory=name=>({name,path:name,kind:'directory',size:0,accessible:true});
async function withWorkspace(routeHandler,work) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/v1/bots/*/workspace/**',routeHandler);
 try {
  await page.goto(fixture.url);await page.locator('#login').waitFor({state:'visible'});await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator(`[data-bot-id="${BOT_A}"]`).click();await page.locator('#more-panels').click();await page.locator('#tab-files').click();
  await work(page);assert.deepEqual(errors,[]);
 } finally {await context.close();await fixture.close();}
}

test('Files shows pending reads without claiming the workspace or Git projects are empty',async()=>{
 const tree=deferred(),projects=deferred(),changes=deferred();
 await withWorkspace(async route=>{
  const endpoint=new URL(route.request().url()).pathname.split('/').at(-1);
  if(endpoint==='tree'){await tree.promise;return route.fulfill({json:{path:'.',entries:[directory('spacetime')],truncated:false}});}
  if(endpoint==='projects'){await projects.promise;return route.fulfill({json:{projects:[project],truncated:false}});}
  if(endpoint==='changes'){await changes.promise;return route.fulfill({json:{project:'spacetime',changes:[],truncated:false}});}
  return route.fulfill({status:404,json:{error:{message:'Unknown test endpoint'}}});
 },async page=>{
  try {
   await page.getByText('Loading files…',{exact:true}).waitFor();await page.getByText('Loading projects…',{exact:true}).waitFor();
   assert.equal(await page.getByText('This folder is empty.',{exact:true}).count(),0);
   assert.equal(await page.getByText('No Git projects in /workspace.',{exact:true}).count(),0);
   tree.resolve();await page.locator('.workspace-file-list .workspace-entry').filter({hasText:'spacetime'}).waitFor();
   assert.equal(await page.getByText('Loading projects…',{exact:true}).isVisible(),true);
   projects.resolve();await page.locator('.workspace-project').click();await page.getByText('Loading changes…',{exact:true}).waitFor();
   assert.equal(await page.getByText('No changes in this project.',{exact:true}).count(),0);
   changes.resolve();await page.getByText('No changes in this project.',{exact:true}).waitFor();
  } finally {tree.resolve();projects.resolve();changes.resolve();}
 });
});

test('Files keeps read failures visible and distinguishes a verified empty result after refresh',async()=>{
 let failed=true;
 await withWorkspace(async route=>{
  const endpoint=new URL(route.request().url()).pathname.split('/').at(-1);
  if(failed)return route.fulfill({status:503,json:{error:{code:'computer_start_failed',message:endpoint==='tree'?'Files are temporarily unavailable.':'Project scan failed.'}}});
  return route.fulfill({json:endpoint==='tree'?{path:'.',entries:[],truncated:false}:{projects:[],truncated:false}});
 },async page=>{
  await page.getByRole('alert').filter({hasText:'Files are temporarily unavailable.'}).waitFor();await page.getByRole('alert').filter({hasText:'Project scan failed.'}).waitFor();
  assert.equal(await page.getByText('This folder is empty.',{exact:true}).count(),0);
  assert.equal(await page.getByText('No Git projects in /workspace.',{exact:true}).count(),0);
  failed=false;await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();
  await page.getByText('This folder is empty.',{exact:true}).waitFor();await page.getByText('No Git projects in /workspace.',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-workspace-explorer] [role="alert"]').count(),0);
 });
});

test('Switching bots during a file read cannot replace the new bot workspace with stale results',async()=>{
 const firstBot=deferred();
 await withWorkspace(async route=>{
  const url=new URL(route.request().url()),isFirst=url.pathname.includes(BOT_A),endpoint=url.pathname.split('/').at(-1);
  if(isFirst)await firstBot.promise;
  const data=endpoint==='tree'?{path:'.',entries:[directory(isFirst?'old-bot-files':'new-bot-files')],truncated:false}:{projects:[],truncated:false};
  await route.fulfill({json:data}).catch(()=>{});
 },async page=>{
  try {
   await page.getByText('Loading files…',{exact:true}).waitFor();await page.locator('#mobile-back').click();await page.locator(`[data-bot-id="${BOT_B}"]`).click();
   if(!await page.locator('[data-workspace-explorer]').isVisible()){await page.locator('#more-panels').click();await page.locator('#tab-files').click();}
   await page.locator('.workspace-entry').filter({hasText:'new-bot-files'}).waitFor();firstBot.resolve();
   await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();await page.locator('.workspace-entry').filter({hasText:'new-bot-files'}).waitFor();
   assert.equal(await page.locator('.workspace-entry').filter({hasText:'old-bot-files'}).count(),0);
  } finally {firstBot.resolve();}
 });
});
