import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN, BOT_A, BOT_B} from './console-fixture.mjs';

// Extend the existing bundled-console fixture locally, without teaching all other
// browser fixtures to simulate tasks. These routes never call inference/computers.
let browser;
after(async()=>{await browser?.close();});
const statuses=['pending','queued','running','waiting_approval','waiting_connection','cancelling','completed','failed','cancelled'];
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
async function withTasks(work,width=1440) {
  browser??=await chromium.launch({headless:true,
    ...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{}),
  });
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900},colorScheme:'light'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
  const tasks={records:statuses.map(status=>({id:`task-${status}`,title:`Task ${status}`,description:`Independent ${status} work`,botId:BOT_A,botName:'Ada',status,createdAt:'2026-10-05T10:00:00.000Z'})),messages:new Map(),approvals:new Map(),calls:[],modelsCalls:[],modelCatalog:{models:[{id:'catalog/model-one',name:'Model One'},{id:'catalog/model-two',name:'Anthropic: Anthropic: Claude Sonnet',publisher:'anthropic'}]},createErrors:0,createGate:null,modelsGate:null,createdByOperation:new Map(),readGates:new Map(),reads:[],sendGate:null,sendError:false};
  for(const task of tasks.records)tasks.messages.set(task.id,[{id:`${task.id}-reply`,role:'assistant',text:`Private conversation for ${task.id}`}]);
  const fulfill=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  await page.route('**/v1/tasks**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method(),body=method==='POST'?request.postDataJSON():undefined;
    tasks.calls.push({path,method,body,headers:request.headers()});
    if(path==='/v1/tasks'){
      if(method==='GET')return fulfill(route,{tasks:tasks.records});
      if(tasks.createGate)await tasks.createGate.promise;
      if(tasks.createdByOperation.has(body.operationId))return fulfill(route,tasks.createdByOperation.get(body.operationId),200);
      let botId=body.botId,bot;
      if(body.newBot){bot={id:randomUUID(),name:body.newBot.name};botId=bot.id;fixture.state.bots.push({...bot,instructions:body.newBot.instructions||'',model:body.newBot.model||fixture.state.modelCatalog.defaultModel,runtime:'pi'});fixture.state.messages.set(bot.id,[]);fixture.state.agents.set(bot.id,[]);fixture.state.agentMessages.set(bot.id,[]);fixture.state.agentMessageOperations.set(bot.id,new Map());fixture.state.delegations.set(bot.id,[]);fixture.state.connections.set(bot.id,[]);fixture.state.apps.set(bot.id,[]);fixture.state.runs.set(bot.id,[]);fixture.state.approvals.set(bot.id,[]);}
      const task={id:randomUUID(),...body,botId,botName:bot?.name||'Ada',...(bot?{dedicatedBot:true}:{}),status:body.startImmediately===false?'pending':'running'};tasks.records.push(task);tasks.messages.set(task.id,[]);
      if(bot)fixture.state.bots.find(item=>item.id===bot.id).taskId=task.id;
      const response={task,...(bot?{bot:{...bot,taskId:task.id}}:{})};tasks.createdByOperation.set(body.operationId,response);
      // Model an accepted atomic commit whose response is lost after the server stores it.
      if(tasks.createErrors>0){tasks.createErrors--;return fulfill(route,{error:{message:'Create response unavailable.'}},503);}
      return fulfill(route,response,201);
    }
    const [,id,tail='']=/^\/v1\/tasks\/([^/]+)(.*)$/.exec(path)||[],task=tasks.records.find(item=>item.id===id);
    if(!task)return fulfill(route,{error:{code:'not_found',message:'Task not found.'}},404);
    if(method==='GET'){
      // Snapshot before the delayed response, as a real stale read would do.
      const payload=structuredClone(tail==='/messages'?{messages:tasks.messages.get(id)||[]}:tail==='/approvals'?{approvals:tasks.approvals.get(id)||[]}:{task});
      const read={id,tail,finished:false};tasks.reads.push(read);
      if(tasks.readGates.has(id))await tasks.readGates.get(id).promise;
      try{return await fulfill(route,payload);}catch(error){if(!request.failure())throw error;}finally{read.finished=true;}
    }
    if(tail==='/continue'){
      if(!['completed','failed'].includes(task.status))return fulfill(route,{error:{code:'task_cancelled',message:'This task cannot continue.'}},409);
      task.status='running';tasks.messages.get(id).push({id:randomUUID(),role:'user',text:body.text});return fulfill(route,{task},202);
    }
    if(tail==='/messages'){
      if(tasks.sendGate)await tasks.sendGate.promise;
      if(tasks.sendError)return fulfill(route,{error:{code:'unavailable',message:'Send response unavailable.'}},503);
      tasks.messages.get(id).push({id:randomUUID(),role:'user',text:body.text});return fulfill(route,{run:{id:randomUUID(),status:'running'}},202);
    }
    if(tail.startsWith('/approvals/')){
      const approval=(tasks.approvals.get(id)||[]).find(item=>item.id===decodeURIComponent(tail.slice('/approvals/'.length)));
      if(!approval)return fulfill(route,{error:{code:'not_found',message:'Approval not found.'}},404);
      approval.status=body.decision==='approve'?'completed':'denied';task.status='running';return fulfill(route,{approval});
    }
    if(tail==='/start')task.status='running';else if(tail==='/cancel')task.status='cancelling';else return fulfill(route,{},404);
    return fulfill(route,{task});
  });
  await page.route('**/v1/models',async route=>{tasks.modelsCalls.push({method:route.request().method(),path:new URL(route.request().url()).pathname});if(tasks.modelsGate)await tasks.modelsGate.promise;return fulfill(route,tasks.modelCatalog);});
  const login=async()=>{
    const modelCatalog=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/models');
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});await modelCatalog;
    await page.locator('#tasks-nav').click();await page.getByRole('region',{name:'Global tasks'}).waitFor();await page.locator('.timber-tasks-card').first().waitFor();
  };
  const open=async id=>{await page.locator(`.timber-tasks-card[data-task-id="${id}"]`).click();await page.locator('.timber-tasks-detail h2').filter({hasText:tasks.records.find(item=>item.id===id).title}).waitFor();};
  const back=()=>page.getByRole('button',{name:'Back to tasks'}).click();
  try {await work({page,tasks,fixture,login,open,back});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);
    assert.ok(tasks.calls.every(call=>call.headers['x-timber-client']==='console'&&!call.headers.authorization),'task requests reuse authenticated console transport');
  }finally{for(const gate of tasks.readGates.values())gate.resolve();tasks.sendGate?.resolve();tasks.createGate?.resolve();tasks.modelsGate?.resolve();await context.close();await fixture.close();}
}

for(const width of [390,1440])test(`global tasks: default auto-start, explicit pending override, status filters and dedicated chat at ${width}px`,async()=>withTasks(async({page,tasks,fixture,login,open,back})=>{
  await login();
  const filters=page.getByRole('group',{name:'Filter tasks by status'}),cards=page.locator('.timber-tasks-card');
  assert.equal(await cards.count(),9,'All retains completed, failed and cancelled');
  await filters.getByRole('button',{name:'Active',exact:true}).click();assert.equal(await cards.count(),5);
  assert.equal(await filters.getByRole('button',{name:'Active',exact:true}).getAttribute('aria-pressed'),'true');
  await filters.getByRole('button',{name:'Pending',exact:true}).click();assert.deepEqual(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId)),['task-pending']);
  await filters.getByRole('button',{name:'Completed',exact:true}).click();assert.deepEqual(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId)),['task-completed']);
  await filters.getByRole('button',{name:'All',exact:true}).click();
  await open('task-running');
  assert.equal(await page.getByLabel('Task conversation').innerText().then(value=>value.includes('Private conversation for task-running')),true);
  assert.equal(await page.getByLabel('Task conversation').innerText().then(value=>value.includes('Organize the research notes')),false,'ordinary bot transcript is not copied into task chat');
  await page.getByLabel('Message this task').fill('Task-only follow-up');await page.getByRole('button',{name:'Send task message',exact:true}).click();
  await page.getByLabel('Task conversation').getByText('Task-only follow-up',{exact:true}).waitFor();
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`).length,0,'task send never steers the ordinary bot');
  assert.equal(fixture.state.messages.get(BOT_A).some(message=>message.text==='Task-only follow-up'),false);
  await back();await page.getByRole('button',{name:'New task',exact:true}).click();
  assert.equal(await page.getByLabel('Start immediately').isChecked(),true);
  assert.equal(await page.getByLabel('Description',{exact:true}).getAttribute('maxlength'),'32000','description respects the server bound');
  await page.getByLabel('Title',{exact:true}).fill('Default immediate task');await page.getByLabel('Description',{exact:true}).fill('Work in the assigned bot computer');
  await page.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h2').filter({hasText:'Default immediate task'}).waitFor();
  assert.equal(tasks.calls.filter(call=>call.path==='/v1/tasks'&&call.method==='POST').at(-1).body.startImmediately,true);
  await back();await page.getByRole('button',{name:'New task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Explicit pending task');await page.getByLabel('Start immediately').uncheck();
  await page.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h2').filter({hasText:'Explicit pending task'}).waitFor();
  assert.equal(tasks.calls.filter(call=>call.path==='/v1/tasks'&&call.method==='POST').at(-1).body.startImmediately,false);
  assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).isVisible(),true);assert.equal(await page.getByLabel('Message this task').count(),0);
  await page.getByRole('button',{name:'Start task',exact:true}).click();await page.getByLabel('Message this task').waitFor();
  assert.equal(await page.getByRole('button',{name:'Cancel task',exact:true}).isVisible(),true);
  const bounds=await page.getByRole('region',{name:'Global tasks'}).evaluate(node=>({right:node.getBoundingClientRect().right,scroll:node.scrollWidth,width:node.clientWidth}));assert.ok(bounds.right<=width+1&&bounds.scroll<=bounds.width+1,'task layout fits viewport');
},width));

test('global tasks: create dedicated bot atomically with task using catalogue model and stable retries',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];await login();const modelsBefore=tasks.modelsCalls.length;
  await page.getByRole('button',{name:'New task',exact:true}).click();
  assert.equal(await page.getByRole('combobox',{name:'Assigned bot',exact:true}).inputValue(),'__new_bot__');
  assert.equal(await page.getByRole('option',{name:'Create a dedicated bot'}).count(),1);
  await page.getByLabel('Title',{exact:true}).fill('Research helper');
  await page.getByLabel('Bot instructions',{exact:true}).fill('Summarize findings with sources.');
  await page.getByLabel('Model (optional)',{exact:true}).selectOption('catalog/model-two');
  await page.getByText('This bot gets its own computer and workspace.',{exact:false}).waitFor();
  assert.equal(tasks.modelsCalls.length,modelsBefore+1,'opening the new-bot form fetches one catalog in addition to any global catalog load');
  assert.equal(await page.getByRole('option',{name:'Claude Sonnet',exact:true}).count(),1,'repeated publisher prefixes are removed from model names');
  assert.equal(await page.getByLabel('Bot name',{exact:true}).getAttribute('maxlength'),'80');
  assert.equal(await page.getByLabel('Bot instructions',{exact:true}).getAttribute('maxlength'),'16000');
  tasks.createErrors=1;
  const submit=async()=>{const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname==='/v1/tasks');await page.getByRole('button',{name:'Create task',exact:true}).click();await response;};
  await submit();await page.getByRole('alert').filter({hasText:'Create response unavailable.'}).waitFor();
  const first=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').at(-1);
  assert.deepEqual(first.body.newBot,{name:'Research helper',instructions:'Summarize findings with sources.',model:'catalog/model-two'});
  assert.equal(first.body.botId,undefined,'new bot is not created in a separate bot POST');
  assert.equal(tasks.records.length,10,'the accepted 503 committed one task');
  assert.equal(fixture.state.bots.filter(bot=>bot.name==='Research helper').length,1,'the accepted 503 committed one bot');
  assert.equal(typeof first.body.operationId,'string');
  await submit();await page.locator('.timber-tasks-detail h2').filter({hasText:'Research helper'}).waitFor();
  let posts=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks');
  assert.equal(posts[0].body.operationId,posts[1].body.operationId,'retrying the same body after a lost response reuses its operation ID');
  assert.equal(posts[0].body.operationId,posts[1].body.operationId,'replay uses the original identity');
  assert.equal(tasks.records.filter(task=>task.title==='Research helper').length,1,'idempotent replay returns one stable task');
  assert.equal(fixture.state.bots.filter(bot=>bot.name==='Research helper').length,1,'idempotent replay does not duplicate bot');
  assert.equal(posts[1].body.operationId,posts[0].body.operationId,'both accepted response and replay share operation identity');
  assert.equal(await page.locator('.timber-tasks-subtitle').innerText().then(value=>value.includes('Dedicated bot')),true,'task detail indicates dedicated bot');
  await page.getByRole('button',{name:'Back to tasks'}).click();await page.getByRole('button',{name:'New task',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Changed research task');await page.getByLabel('Bot name',{exact:true}).fill('Research helper');await page.getByLabel('Bot instructions',{exact:true}).fill('Changed after the failed response.');
  await page.getByLabel('Model (optional)',{exact:true}).selectOption('catalog/model-two');await submit();await page.locator('.timber-tasks-detail h2').filter({hasText:'Changed research task'}).waitFor();
  posts=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks');
  assert.notEqual(posts[1].body.operationId,posts[2].body.operationId,'changed fields get a new operation identity');
  assert.deepEqual(posts[2].body.newBot,{name:'Research helper',instructions:'Changed after the failed response.',model:'catalog/model-two'});
  assert.equal(posts.length,3,'each submission goes through the single atomic task endpoint');
  assert.equal(tasks.records.length,11,'changed fields after failure create exactly one new task');
  assert.equal(fixture.state.bots.filter(bot=>bot.name==='Research helper').length,2,'changed fields after failure create exactly one new bot');
  assert.equal(posts[2].body.operationId===posts[1].body.operationId,false,'changed fields after failure use a new operation ID');
  assert.equal(tasks.modelsCalls.length,modelsBefore+2,'reopening new-bot form fetches its catalogue again');
  await page.locator('#bot-list').getByText('Research helper',{exact:true}).last().waitFor();
  await page.getByRole('button',{name:'Open bot',exact:true}).click();
  await page.locator('#selected-name').getByText('Research helper',{exact:true}).waitFor();
  assert.equal(fixture.state.calls.some(call=>call.method==='POST'&&/\/inference|\/messages$/.test(call.path||'')),false,'model catalogue and task creation do not run paid inference');
}));

test('global tasks: dedicated bot form stays accessible and fits a 320px viewport',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];await login();const modelsBefore=tasks.modelsCalls.length;await page.getByRole('button',{name:'New task',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Narrow helper');
  await page.getByLabel('Bot instructions',{exact:true}).fill('Optional instructions.');
  await page.getByLabel('Model (optional)',{exact:true}).waitFor();
  assert.equal(tasks.modelsCalls.length,modelsBefore+1,'opening new-bot form fetches model catalogue once');
  const geometry=await page.getByRole('region',{name:'Global tasks'}).evaluate(node=>({scroll:node.scrollWidth,width:node.clientWidth,right:node.getBoundingClientRect().right}));
  assert.ok(geometry.scroll<=geometry.width+1&&geometry.right<=321,'new-bot form does not overflow 320px viewport');
  for(const locator of [page.getByRole('button',{name:'Create task',exact:true}),page.getByRole('button',{name:'Cancel',exact:true}),page.getByRole('button',{name:'New task',exact:true})])assert.ok(await locator.evaluate(node=>node.getBoundingClientRect().height>=44),'touch targets are at least 44px tall');
  assert.equal(await page.getByLabel('Bot name',{exact:true}).inputValue(),'Narrow helper','task title is an editable suggested bot name');
},320));

test('global tasks: model catalogue errors leave backend default and do not refetch on unrelated props',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];tasks.modelCatalog={models:[],error:'Model catalogue unavailable.'};await login();
  const before=tasks.modelsCalls.length;await page.getByRole('button',{name:'New task',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Model catalogue unavailable.'}).waitFor();
  assert.equal(tasks.modelsCalls.length,before+1);
  assert.equal(await page.getByLabel('Model (optional)',{exact:true}).inputValue(),'','catalog error keeps backend default selected');
  const botsRefreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/bots'&&response.request().method()==='GET');
  await page.getByRole('button',{name:'Refresh bots',exact:true}).click();await botsRefreshed;
  assert.equal(tasks.modelsCalls.length,before+1,'unrelated parent rerender does not retry a failed model fetch');
}));

test('global tasks: initial task deep links change selection, return to overview, and ignore unrelated props',async()=>withTasks(async({page,tasks,login,open})=>{
  const running=tasks.records.find(task=>task.id==='task-running'),failed=tasks.records.find(task=>task.id==='task-failed');
  for(const task of [running,failed]){const old=task.id;task.id=randomUUID();tasks.messages.set(task.id,tasks.messages.get(old));tasks.messages.delete(old);}
  await login();
  const navigate=async(hash)=>page.evaluate(value=>{history.pushState(null,'',`${location.pathname}${location.search}${value}`);dispatchEvent(new PopStateEvent('popstate'));},hash);
  await navigate(`#tasks&task=${running.id}`);
  await page.locator('.timber-tasks-detail h2').filter({hasText:'Task running'}).waitFor();
  await navigate(`#tasks&task=${failed.id}`);
  await page.locator('.timber-tasks-detail h2').filter({hasText:'Task failed'}).waitFor();
  await navigate('#tasks');
  await page.getByRole('button',{name:'New task',exact:true}).waitFor();
  await open('task-waiting_connection');
  await page.getByRole('button',{name:'Refresh bots',exact:true}).click();
  await page.locator('.timber-tasks-detail h2').filter({hasText:'Task waiting_connection'}).waitFor();
  assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-waiting_connection','unrelated parent props do not reset manual task selection');
}));

test('global tasks: pending creation freezes every form mutation until atomic response',async()=>withTasks(async({page,tasks,login})=>{
  await login();await page.getByRole('button',{name:'New task',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Freeze while creating');tasks.createGate=deferred();
  const dispatched=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/v1/tasks'),response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname==='/v1/tasks');
  await page.getByRole('button',{name:'Create task',exact:true}).click();await dispatched;
  assert.equal(await page.locator('.timber-tasks-create fieldset').isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Close',exact:true}).isDisabled(),true,'form view cannot close during creation');
  assert.equal(await page.getByRole('button',{name:'New task',exact:true}).isDisabled(),true,'new task view cannot toggle during creation');
  assert.equal(await page.locator('.timber-tasks-create input').first().isDisabled(),true);
  assert.equal(await page.locator('.timber-tasks-card').first().isDisabled(),true,'switching to another task is frozen');
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').length,1);
  tasks.createGate.resolve();await response;await page.locator('.timber-tasks-detail h2').filter({hasText:'Freeze while creating'}).waitFor();
}));

test('global tasks: approval decisions are task-scoped, expired/executing approvals cannot be approved',async()=>withTasks(async({page,tasks,fixture,login,open,back})=>{
  const approval=(id,status='pending',expiresAt=new Date(Date.now()+60000).toISOString())=>({id,status,action:{type:'exec',command:'printf task-only'},expiresAt});
  tasks.approvals.set('task-waiting_approval',[approval('task-approval'),approval('expired-approval','pending','2020-01-01T00:00:00.000Z'),approval('executing-approval','executing')]);
  fixture.state.approvals.set(BOT_A,[approval('ordinary-bot-approval')]);
  await login();await open('task-waiting_approval');const panel=page.getByRole('region',{name:'Task approvals'});
  await panel.locator('[data-task-approval-id="task-approval"]').waitFor();
  assert.equal(await panel.locator('[data-task-approval-id="expired-approval"]').getByRole('button').count(),0);
  assert.equal(await panel.locator('[data-task-approval-id="executing-approval"]').getByRole('button').count(),0);
  assert.equal(await panel.locator('[data-task-approval-id="ordinary-bot-approval"]').count(),0);
  await panel.locator('[data-task-approval-id="task-approval"]').getByRole('button',{name:'Approve',exact:true}).click();
  await panel.locator('[data-task-approval-id="task-approval"]').waitFor({state:'detached'});
  assert.deepEqual(tasks.calls.find(call=>call.method==='POST'&&call.path.endsWith('/approvals/task-approval')).body,{decision:'approve'});
  assert.equal(fixture.state.approvals.get(BOT_A)[0].status,'pending');
  tasks.approvals.set('task-running',[approval('denied-task-approval')]);await back();await open('task-running');
  await panel.locator('[data-task-approval-id="denied-task-approval"]').getByRole('button',{name:'Deny',exact:true}).click();await panel.locator('[data-task-approval-id="denied-task-approval"]').waitFor({state:'detached'});
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path.includes('/approvals/')).length,2);
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path.includes('/approvals/')).length,0,'no decision is posted to the assigned bot conversation');
}));

test('global tasks: retry identities include task ID and late sends cannot clear a replacement task draft',async()=>withTasks(async({page,tasks,login,open,back})=>{
  await login();await open('task-running');tasks.sendError=true;
  const send=async()=>{await page.getByLabel('Message this task').fill('Identical follow-up');const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname.endsWith('/messages'));await page.getByRole('button',{name:'Send task message',exact:true}).click();await response;await page.getByRole('alert').filter({hasText:'Send response unavailable.'}).waitFor();};
  await send();await send();const first=tasks.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));
  assert.equal(first[0].body.operationId,first[1].body.operationId,'same failed task message preserves retry identity');
  await back();await open('task-waiting_connection');await send();
  const sends=tasks.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));assert.notEqual(sends[0].body.operationId,sends[2].body.operationId,'same text in another task gets a distinct identity');
  tasks.sendError=false;tasks.sendGate=deferred();
  const dispatched=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/messages'));
  await page.getByRole('button',{name:'Send task message',exact:true}).click();await dispatched;
  await back();await open('task-running');await page.getByLabel('Message this task').fill('Keep this new draft');const sent=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/messages'));tasks.sendGate.resolve();await sent;
  await page.getByRole('button',{name:'Refresh task'}).click();await page.locator('.timber-tasks-detail h2').filter({hasText:'Task running'}).waitFor();
  assert.equal(await page.getByLabel('Message this task').inputValue(),'Keep this new draft');assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-running');
}));

test('global tasks: a delayed polling response cannot replace a new task view',async()=>withTasks(async({page,tasks,login,open,back})=>{
  await page.clock.install();await login();await open('task-running');
  const gate=deferred();tasks.readGates.set('task-running',gate);
  const before=tasks.reads.length,polling=page.waitForRequest(request=>request.method()==='GET'&&new URL(request.url()).pathname==='/v1/tasks/task-running/messages');await page.clock.fastForward(8001);await polling;
  assert.ok(tasks.reads.slice(before).some(read=>read.id==='task-running'),'real task interval initiates polling');
  await back();await open('task-waiting_connection');gate.resolve();
  await page.getByRole('button',{name:'Refresh task'}).click();
  await page.getByLabel('Task conversation').getByText('Private conversation for task-waiting_connection',{exact:true}).waitFor();
  assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-waiting_connection');
  assert.equal(await page.getByLabel('Task conversation').getByText('Private conversation for task-running',{exact:true}).count(),0);
}));

test('global tasks: signing out aborts pending task reads and stops polling after unmount',async()=>withTasks(async({page,tasks,login,open})=>{
  await page.clock.install();await login();await open('task-running');
  const gate=deferred();tasks.readGates.set('task-running',gate);
  const polling=page.waitForRequest(request=>new URL(request.url()).pathname==='/v1/tasks/task-running/messages');
  await page.clock.fastForward(8001);await polling;
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.locator('#login').waitFor({state:'visible'});
  gate.resolve();const count=tasks.calls.length;await page.clock.fastForward(16001);await page.evaluate(()=>Promise.resolve());
  assert.equal(tasks.calls.length,count,'unmounted task component has no surviving timer');
  assert.equal(await page.getByRole('region',{name:'Global tasks'}).count(),0,'task island was actually unmounted');
}));


test('global tasks: assigned bot defaults recover when the catalogue arrives or the selected bot disappears',async()=>withTasks(async({page,fixture,login})=>{
  const bots=fixture.state.bots;fixture.state.bots=[];
  await login();await page.getByRole('button',{name:'New task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Catalogue arrival');
  assert.equal(await page.getByRole('combobox',{name:'Assigned bot',exact:true}).inputValue(),'__new_bot__','no existing bots defaults to creating a dedicated bot');
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isEnabled(),true,'new bot can be assigned with an empty catalogue');
  fixture.state.bots=bots;await page.getByRole('button',{name:'Refresh bots',exact:true}).click();
  assert.equal(await page.getByRole('combobox',{name:'Assigned bot',exact:true}).inputValue(),'__new_bot__','new bot remains selected when catalogue arrives');
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isEnabled(),true);
  await page.getByLabel('Assigned bot',{exact:true}).selectOption(BOT_A);
  fixture.state.bots=bots.filter(bot=>bot.id===BOT_B);await page.getByRole('button',{name:'Refresh bots',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.timber-tasks-create select')?.value===id,BOT_B);
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isEnabled(),true);
}));

for(const status of ['completed','failed'])test(`global tasks: ${status} Continue is an explicit new task input, cancelled tasks stay stopped`,async()=>withTasks(async({page,tasks,fixture,login,open,back})=>{
  await login();await open(`task-${status}`);
  await page.getByRole('button',{name:'Continue task',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).count(),0);
  await page.getByLabel('Message this task').fill('New instructions, not an old action retry');
  await page.getByRole('button',{name:'Continue task',exact:true}).click();
  await page.getByLabel('Task conversation').getByText('New instructions, not an old action retry',{exact:true}).waitFor();
  const calls=tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/task-${status}/continue`);
  assert.equal(calls.length,1);assert.equal(typeof calls[0].body.operationId,'string');assert.equal(calls[0].body.text,'New instructions, not an old action retry');
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/task-${status}/start`).length,0);
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`).length,0);
  await back();await open('task-cancelled');assert.equal(await page.getByRole('button',{name:'Continue task',exact:true}).count(),0);assert.equal(await page.getByLabel('Message this task').count(),0);assert.equal(await page.getByText('Cancelled tasks stay stopped. Create a new task to work again.',{exact:true}).isVisible(),true);
}));

test('global tasks: same-task deep link reopens after internal back and browser history navigation',async()=>withTasks(async({page,login})=>{
  await login();
  const visit=async(hash)=>page.evaluate(value=>{history.pushState(null,'',`${location.pathname}${location.search}${value}`);dispatchEvent(new PopStateEvent('popstate'));},hash);
  await visit('#tasks&task=task-running');await page.locator('.timber-tasks-detail[data-task-id="task-running"]').waitFor();
  await page.getByRole('button',{name:'Back to tasks'}).click();await page.getByRole('button',{name:'New task'}).waitFor();
  await visit('#tasks&task=task-running');await page.locator('.timber-tasks-detail[data-task-id="task-running"]').waitFor();
  await visit('#tasks&task=task-failed');await page.locator('.timber-tasks-detail[data-task-id="task-failed"]').waitFor();
  await page.goBack();await page.locator('.timber-tasks-detail[data-task-id="task-running"]').waitFor();
  await page.goForward();await page.locator('.timber-tasks-detail[data-task-id="task-failed"]').waitFor();
}));

test('global tasks: bot-name suggestion is capped but editable and can be cleared for validation',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];await login();await page.getByRole('button',{name:'New task'}).click();
  const longTitle='A'.repeat(120);await page.getByLabel('Title',{exact:true}).fill(longTitle);
  const name=page.getByLabel('Bot name',{exact:true});
  assert.equal(await name.inputValue(),'A'.repeat(80),'the suggested name is capped at 80 characters');
  assert.equal(await name.getAttribute('maxlength'),'80');
  await name.fill('');assert.equal(await name.inputValue(),'','the editable suggestion can be cleared');
  assert.equal(await page.getByRole('button',{name:'Create task'}).isDisabled(),true,'a cleared dedicated bot name is not silently restored');
  await name.fill('A valid name');await page.getByLabel('Bot instructions',{exact:true}).fill('I'.repeat(16000));
  assert.equal(await page.getByLabel('Bot instructions',{exact:true}).getAttribute('maxlength'),'16000');
  await page.getByLabel('Bot instructions',{exact:true}).fill('');
  assert.equal(await page.getByRole('button',{name:'Create task'}).isEnabled(),true);
}));

test('global tasks: late catalogue response cannot mutate a submitted draft or operation',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];await login();tasks.modelsGate=deferred();
  await page.getByRole('button',{name:'New task'}).click();
  const title=page.getByLabel('Title',{exact:true}),name=page.getByLabel('Bot name',{exact:true}),instructions=page.getByLabel('Bot instructions',{exact:true});
  await title.fill('Submitted before catalogue');await name.fill('Clear identity');await instructions.fill('Keep this instruction');
  const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname==='/v1/tasks');
  await page.getByRole('button',{name:'Create task'}).click();await response;
  const post=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').at(-1);
  assert.deepEqual(post.body.newBot,{name:'Clear identity',instructions:'Keep this instruction'});
  assert.ok(post.body.operationId);
  tasks.modelsGate.resolve();await page.waitForTimeout(30);
  assert.equal(await page.locator('.timber-tasks-detail h2').innerText(),'Submitted before catalogue');
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').length,1,'late catalogue did not trigger or mutate a second create');
}));

test('global tasks: a successful stale-view response retains draft and operation identity for safe replay',async()=>withTasks(async({page,tasks,fixture,login})=>{
  fixture.state.bots=[];await login();await page.getByRole('button',{name:'New task'}).click();
  await page.getByLabel('Title',{exact:true}).fill('Retain stale view draft');await page.getByLabel('Bot instructions',{exact:true}).fill('Still available after navigation');
  tasks.createGate=deferred();const dispatched=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/v1/tasks'),response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname==='/v1/tasks');
  await page.getByRole('button',{name:'Create task'}).click();await dispatched;
  const visit=page.evaluate(()=>{history.pushState(null,'',`${location.pathname}${location.search}#tasks&task=task-failed`);dispatchEvent(new PopStateEvent('popstate'));});await visit;
  await page.locator('.timber-tasks-detail[data-task-id="task-failed"]').waitFor();tasks.createGate.resolve();await response;
  await page.getByRole('button',{name:'Back to tasks'}).click();
  await page.getByLabel('Title',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Retain stale view draft');
  assert.equal(await page.getByLabel('Bot instructions',{exact:true}).inputValue(),'Still available after navigation');
  const operations=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks').map(call=>call.body.operationId);
  await page.getByRole('button',{name:'Create task'}).click();await page.locator('.timber-tasks-detail h2').filter({hasText:'Retain stale view draft'}).waitFor();
  const posts=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks');
  assert.equal(posts[1].body.operationId,operations[0],'replay after stale successful response keeps original operation ID');
  assert.equal(tasks.records.filter(task=>task.title==='Retain stale view draft').length,1,'stale replay does not duplicate task');
  assert.equal(fixture.state.bots.filter(bot=>bot.name==='Retain stale view draft').length,1,'stale replay does not duplicate bot');
}));
