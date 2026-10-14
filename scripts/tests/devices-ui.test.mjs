import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createConsoleFixture,TEST_TOKEN,BOT_A} from './console-fixture.mjs';

let browser;after(async()=>{await browser?.close()});
const date='2026-10-05T10:00:00.000Z';
const target={kind:'device',deviceId:'machine-local',workspaceId:'repo',agentMode:'cloud'};
const machine=()=>({id:target.deviceId,name:'Owner workstation',platform:'darwin',version:'1',status:'online',online:true,workspaces:[{id:'repo',name:'Timber repo',path:'/Users/owner/timber',capabilities:['diagnostics','files.read','files.write','host.shell','agent.run']}],grants:[],createdAt:date,privateKey:'FIXTURE_PRIVATE_NOT_PUBLIC',token:'FIXTURE_SECRET_NOT_PUBLIC'});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
async function withMachines(work,width=1440){
  browser??=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
  const state={devices:[],calls:[],tasks:[],taskCalls:[],readGate:null,pairError:false};
  const fulfill=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  await page.route('**/v1/devices**',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method(),body=method==='POST'?req.postDataJSON():undefined,headers=req.headers();
    state.calls.push({path:url.pathname,method,body,headers});
    const session=/(?:^|;\s*)timber_fixture_session=([^;]+)/.exec(headers.cookie||'')?.[1];
    if(!fixture.state.sessions.has(session)||headers['x-timber-client']!=='console'||headers.authorization)return fulfill(route,{error:{code:'unauthorized',message:'Session rejected.'}},401);
    if(url.pathname==='/v1/devices'){
      const snapshot=structuredClone({devices:state.devices});if(state.readGate)await state.readGate.promise;
      try{return await fulfill(route,snapshot)}catch(error){if(!req.failure())throw error;return;}
    }
    if(url.pathname==='/v1/devices/pairings/approve'){
      if(state.pairError||body.code!=='PAIR-ONE-TIME')return fulfill(route,{error:{code:'pairing_invalid',message:'Pairing code expired. Generate a new code in the runner.'}},400);
      const device=machine();state.devices.push(device);return fulfill(route,{device});
    }
    const [,id,tail='']=/^\/v1\/devices\/([^/]+)(.*)$/.exec(url.pathname)||[],device=state.devices.find(item=>item.id===id);
    if(!device)return fulfill(route,{},404);
    if(tail==='/grants'&&method==='POST'){device.grants=device.grants.filter(grant=>grant.botId!==body.botId);device.grants.push({...body,epoch:1,updatedAt:date});return fulfill(route,{device});}
    if(tail.startsWith('/grants/')&&method==='DELETE'){device.grants=device.grants.filter(grant=>grant.botId!==tail.slice('/grants/'.length));return fulfill(route,{device});}
    if(!tail&&method==='DELETE'){device.status='revoked';device.online=false;device.grants=[];return fulfill(route,{device});}
    return fulfill(route,{},404);
  });
  await page.route('**/v1/tasks**',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method(),body=method==='POST'?req.postDataJSON():undefined;state.taskCalls.push({path:url.pathname,method,body});
    if(url.pathname==='/v1/tasks'){
      if(method==='GET')return fulfill(route,{tasks:state.tasks});
      const bot=fixture.state.bots.find(item=>item.id===body.botId),task={id:randomUUID(),...body,status:body.startImmediately===false?'pending':'running',botName:bot.name,executionTarget:body.executionTarget||bot.executionTarget,createdAt:date};state.tasks.push(task);return fulfill(route,{task},201);
    }
    const [,id,tail='']=/^\/v1\/tasks\/([^/]+)(.*)$/.exec(url.pathname)||[],task=state.tasks.find(item=>item.id===id);
    if(!task)return fulfill(route,{},404);
    if(tail==='/events')return url.searchParams.get('format')==='json'?fulfill(route,{events:[],nextCursor:null}):route.fulfill({status:200,contentType:'text/event-stream',body:''});
    if(tail==='/messages')return fulfill(route,{messages:[{id:'machine-task-message',botId:task.botId,role:'user',text:'Work on the machine',createdAt:date}],nextCursor:null});
    if(tail==='/runs')return fulfill(route,{runs:[],activeRuns:[],nextCursor:null});
    if(tail==='/approvals')return fulfill(route,{approvals:[]});if(tail==='/agents')return fulfill(route,{agents:[],delegations:[]});if(tail==='/keychain')return fulfill(route,{entries:[],requests:[]});if(tail==='/connections')return fulfill(route,{connections:[]});
    return fulfill(route,{task});
  });
  const login=async()=>{await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});};
  const settings=async()=>{await page.locator('#settings-button').click();const dialog=page.locator('#settings-dialog');await dialog.waitFor();await dialog.getByRole('region',{name:'Machines',exact:true}).waitFor();return dialog;};
  const bots=async()=>{if(!await page.locator('#bot-search').isVisible())await page.locator('#toggle-bots').click();};
  try{await work({page,state,fixture,login,settings,bots});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);assert.ok(state.calls.every(call=>call.headers['x-timber-client']==='console'&&!call.headers.authorization),'machines use authenticated cookie transport');}
  finally{state.readGate?.resolve();await context.close();await fixture.close();}
}
const chooseTarget=async(picker,targetValue=target)=>{
  const select=picker.getByLabel('Execution location',{exact:true});await select.locator('option').filter({hasText:'Owner workstation / Timber repo'}).waitFor({state:'attached'});
  await select.selectOption(JSON.stringify({kind:'device',deviceId:targetValue.deviceId,workspaceId:targetValue.workspaceId}));
};
const closeSettings=async page=>page.getByRole('button',{name:'Close settings',exact:true}).click();

for(const width of [390,1440])test(`machines: pairing grants only checked permissions and supports bot/machine revoke at ${width}px`,async()=>withMachines(async({page,state,login,settings})=>{
  await login();const dialog=await settings();await dialog.getByLabel('Pairing code').fill('PAIR-ONE-TIME');await dialog.getByRole('button',{name:'Pair machine',exact:true}).click();
  const card=dialog.locator('[data-device-id="machine-local"]');await card.waitFor();assert.equal(await dialog.getByLabel('Pairing code').inputValue(),'');
  assert.match(await card.innerText(),/Timber repo/);assert.doesNotMatch(await dialog.innerText(),/FIXTURE_PRIVATE_NOT_PUBLIC|FIXTURE_SECRET_NOT_PUBLIC/);
  await card.locator('summary').click();assert.equal(await card.locator('input:checked').count(),0);assert.equal(await card.getByRole('button',{name:'Save machine access'}).isDisabled(),true);
  await card.getByLabel('Bot',{exact:true}).selectOption(BOT_A);assert.equal(await card.locator('input:checked').count(),0);
  await card.getByLabel('Timber repo',{exact:true}).check();await card.getByLabel('Read files',{exact:true}).check();await card.getByLabel('Run shell commands',{exact:true}).check();
  assert.match(await card.innerText(),/user’s privileges.*not a sandbox/s);
  await card.getByRole('button',{name:'Save machine access'}).click();await card.getByRole('button',{name:'Revoke Ada access',exact:true}).waitFor();
  const grant=state.calls.find(call=>call.method==='POST'&&call.path.endsWith('/grants'));assert.deepEqual(grant.body,{botId:BOT_A,workspaceIds:['repo'],permissions:['files.read','host.shell']});
  await card.getByRole('button',{name:'Revoke Ada access',exact:true}).click();await card.getByRole('button',{name:'Revoke Ada access',exact:true}).waitFor({state:'hidden'});assert.equal(state.devices[0].grants.length,0);
  await card.getByRole('button',{name:'Revoke machine',exact:true}).click();await card.locator('[data-device-status="revoked"]').waitFor();assert.equal(await card.locator('form').count(),0);
  assert.ok(state.calls.some(call=>call.path===`/v1/devices/machine-local/grants/${BOT_A}`&&call.method==='DELETE'));assert.ok(state.calls.some(call=>call.path==='/v1/devices/machine-local'&&call.method==='DELETE'));
  const box=await card.evaluate(node=>({scroll:node.scrollWidth,width:node.clientWidth}));assert.ok(box.scroll<=box.width+1);
  await mkdir('/tmp/timber-devices-screenshots',{recursive:true});await dialog.evaluate(node=>node.scrollTop=0);await page.screenshot({path:`/tmp/timber-devices-screenshots/settings-${width}.png`});
},width));

test('machines: pairing errors remain inline; closing Settings clears the one-time code',async()=>withMachines(async({page,state,login,settings})=>{
  await login();state.pairError=true;const dialog=await settings();await dialog.getByLabel('Pairing code').fill('EXPIRED-PAIR');await dialog.getByRole('button',{name:'Pair machine',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Pairing code expired'}).waitFor();assert.equal(state.devices.length,0);
  await closeSettings(page);await settings();assert.equal(await dialog.getByLabel('Pairing code').inputValue(),'');
}));

test('machines: bot create/edit preserve models and offline targets; busy target changes show inline 409',async()=>withMachines(async({page,state,fixture,login,bots})=>{
  state.devices=[machine()];await login();await bots();await page.locator('#new-bot').click();await page.locator('#bot-dialog').waitFor();await page.locator('#bot-name').fill('Native helper');
  await chooseTarget(page.locator('#bot-execution-target'));await page.locator('#bot-execution-target').getByLabel('Agent location',{exact:true}).selectOption('local');
  assert.match(await page.locator('#bot-execution-target').innerText(),/explicit agent.run grant/);
  await page.locator('#create-form').getByRole('button',{name:'Create bot',exact:true}).click();await page.locator('#bot-dialog').waitFor({state:'hidden'});
  const created=fixture.state.calls.find(call=>call.path==='/v1/bots'&&call.method==='POST');assert.deepEqual(created.body.executionTarget,{...target,agentMode:'local'});assert.equal(created.body.model,'gpt-6.1-sol');assert.equal(created.body.computerApprovalMode,'ask');assert.equal(state.calls.filter(call=>call.path.endsWith('/grants')&&call.method==='POST').length,0);
  state.devices[0].online=false;state.devices[0].status='offline';await page.locator('#panel-menu').locator('summary').click();await page.locator('#edit-bot').click();await page.locator('#edit-execution-target').getByRole('status').filter({hasText:'Offline'}).waitFor();assert.equal(await page.locator('#edit-execution-target').getByLabel('Agent location').inputValue(),'local');
  fixture.state.patchError={code:'target_busy',message:'Stop active work before changing execution location.',status:409};await page.locator('#edit-execution-target').getByLabel('Agent location').selectOption('cloud');await page.locator('#edit-form').getByRole('button',{name:'Save changes'}).click();await page.locator('#edit-error').filter({hasText:'Stop active work'}).waitFor();assert.equal(await page.locator('#edit-dialog').isVisible(),true);
  fixture.state.patchError=null;await page.locator('#edit-form').getByRole('button',{name:'Save changes'}).click();await page.locator('#edit-dialog').waitFor({state:'hidden'});
  const patched=fixture.state.calls.filter(call=>call.method==='PATCH').at(-1);assert.deepEqual(patched.body.executionTarget,target);assert.equal(fixture.state.bots.find(bot=>bot.name==='Native helper').executionTarget.kind,'device');
}));

for(const width of [390,1440])test(`machines: tasks inherit or explicitly override bot location and keep shared conversation at ${width}px`,async()=>withMachines(async({page,state,fixture,login,bots})=>{
  state.devices=[machine()];fixture.state.bots[0].executionTarget={...target,agentMode:'local'};
  await login();await bots();await page.locator('#tasks-nav').click();await page.getByRole('button',{name:'New task',exact:true}).click();let form=page.locator('.timber-tasks-create');await form.getByLabel('Title',{exact:true}).fill('Inherited task');await form.getByLabel('Assigned bot',{exact:true}).selectOption(BOT_A);
  assert.match(await form.getByLabel('Execution location',{exact:true}).locator('option:checked').innerText(),/Use bot location.*Local Pi/);
  await form.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h1').filter({hasText:'Inherited task'}).waitFor();
  assert.equal(state.taskCalls.find(call=>call.method==='POST'&&call.path==='/v1/tasks').body.executionTarget,undefined);
  await page.locator('.timber-tasks-detail #message').waitFor();assert.equal(await page.locator('#messages').count(),1);assert.equal(await page.locator('#message-form').count(),1);assert.equal(await page.getByRole('button',{name:'Task computer',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Task details',exact:true}).click();const details=page.getByRole('dialog',{name:'Task details',exact:true});await details.waitFor();assert.match(await details.innerText(),/Owner workstation.*Timber repo.*Local Pi/);await details.getByRole('button',{name:'Close task details',exact:true}).click();
  await mkdir('/tmp/timber-devices-screenshots',{recursive:true});await page.screenshot({path:`/tmp/timber-devices-screenshots/task-${width}.png`});
  if(width<760)await page.getByRole('button',{name:'Back to tasks',exact:true}).click();else await page.locator('#tasks-nav').click();await page.getByRole('button',{name:'New task',exact:true}).click();form=page.locator('.timber-tasks-create');await form.getByLabel('Title',{exact:true}).fill('Cloud override');await form.getByLabel('Assigned bot',{exact:true}).selectOption(BOT_A);await form.getByLabel('Execution location',{exact:true}).selectOption('cloud');await form.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h1').filter({hasText:'Cloud override'}).waitFor();
  assert.deepEqual(state.taskCalls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').at(-1).body.executionTarget,{kind:'cloud'});assert.equal(await page.getByRole('button',{name:'Task computer',exact:true}).isDisabled(),false);
  assert.equal(state.taskCalls.filter(call=>/desktop|computer|apps/.test(call.path)).length,0);
},width));

test('machines: native computer exposes only supported tools and never starts Cloud desktop or previews',async()=>withMachines(async({page,state,fixture,login,bots})=>{
  state.devices=[machine()];fixture.state.bots[0].executionTarget={...target,agentMode:'local'};await login();await bots();await page.locator(`#bot-list [data-bot-id="${BOT_A}"]`).click();await page.locator('#messages').waitFor();
  await page.getByRole('button',{name:'Context and memory',exact:true}).click();
  await page.getByText('Pi on your machine summarizes older context automatically. Durable memory stays in Timber.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Compact now',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Review history',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Add memory',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'Close context and memory',exact:true}).click();
  await page.locator('#panel-menu').locator('summary').click();await page.locator('#tab-computer').click();await page.locator('#panel-computer').waitFor();await page.locator('#machine-computer-notice').waitFor();
  assert.equal(await page.locator('#desktop-root').isVisible(),false);assert.equal(await page.locator('#checkpoint').isVisible(),false);assert.equal(await page.locator('#suspend-computer').isVisible(),false);
  await page.locator('#computer-tools').locator('summary').first().click();assert.equal(await page.locator('#navigate-form').isVisible(),false);assert.equal(await page.locator('#take-screenshot').isVisible(),false);assert.match(await page.locator('#computer-working-directory').innerText(),/\/Users\/owner\/timber/);
  await page.locator('#exec-command').fill('pwd');await page.locator('#exec-form').getByRole('button',{name:'Run command',exact:true}).click();await page.locator('#result-details').waitFor();assert.equal(fixture.state.actions.at(-1).action.type,'exec');
  assert.equal(fixture.state.calls.filter(call=>/desktop|live-session/.test(call.path)).length,0);assert.ok(fixture.state.actions.every(call=>!['checkpoint','screenshot'].includes(call.action.type)));
  await page.locator('#workspace-sidebar').getByRole('button',{name:'Apps',exact:true}).click();await page.locator('#apps-feedback').filter({hasText:'unavailable on machine targets'}).waitFor();assert.equal(await page.locator('#apps-prompt').isVisible(),false);
}));

test('machines: logout aborts stale machine reads and drops owner grants/code before reconnect',async()=>withMachines(async({page,state,login,settings})=>{
  state.devices=[machine()];await login();const dialog=await settings();await dialog.locator('[data-device-id]').waitFor();await dialog.getByLabel('Pairing code').fill('UNSENT-OWNER-CODE');
  const gate=deferred();state.readGate=gate;await dialog.getByRole('button',{name:'Refresh machines',exact:true}).click();await dialog.getByRole('button',{name:'Refresh machines',exact:true,disabled:true}).waitFor();
  await dialog.locator('#disconnect').click();await page.locator('#connect-form').waitFor();state.devices=[];state.readGate=null;gate.resolve();
  await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();await settings();await page.getByText('No paired machines.',{exact:true}).waitFor();assert.equal(await page.locator('[data-device-id]').count(),0);assert.equal(await page.getByLabel('Pairing code').inputValue(),'');assert.doesNotMatch(await page.locator('#settings-dialog').innerText(),/Owner workstation|UNSENT-OWNER-CODE/);
}));


test('machines: unavailable configured targets stay selected when registry no longer advertises the machine',async()=>withMachines(async({page,fixture,login,bots})=>{
  fixture.state.bots[0].executionTarget={...target,agentMode:'local'};await login();await bots();await page.locator(`#bot-list [data-bot-id="${BOT_A}"]`).click();await page.locator('#messages').waitFor();await page.locator('#panel-menu').locator('summary').click();await page.locator('#edit-bot').click();
  const picker=page.locator('#edit-execution-target');assert.equal(await picker.getByLabel('Execution location').inputValue(),JSON.stringify({kind:'device',deviceId:target.deviceId,workspaceId:target.workspaceId}));assert.match(await picker.innerText(),/Unavailable machine.*Offline/s);assert.equal(await picker.getByLabel('Agent location').inputValue(),'local');
  await page.locator('#edit-form').getByRole('button',{name:'Save changes'}).click();await page.locator('#edit-dialog').waitFor({state:'hidden'});assert.deepEqual(fixture.state.calls.filter(call=>call.method==='PATCH').at(-1).body.executionTarget,{...target,agentMode:'local'});
}));


test('machines: runner pairing link opens authenticated Settings after sign-in',async()=>withMachines(async({page,fixture})=>{
  await page.goto(fixture.url+'#devices');assert.equal(await page.locator('#settings-dialog').isVisible(),false);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor();await page.locator('#settings-dialog').waitFor();await page.getByRole('region',{name:'Machines',exact:true}).waitFor();assert.equal(await page.getByLabel('Pairing code').isVisible(),true);
}));
