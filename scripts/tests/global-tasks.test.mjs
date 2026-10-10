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
  const tasks={records:statuses.map(status=>({id:`task-${status}`,title:`Task ${status}`,description:`Independent ${status} work`,botId:BOT_A,botName:'Ada',status,createdAt:'2026-10-05T10:00:00.000Z'})),messages:new Map(),approvals:new Map(),calls:[],readGates:new Map(),reads:[],sendGate:null,sendError:false};
  for(const task of tasks.records)tasks.messages.set(task.id,[{id:`${task.id}-reply`,role:'assistant',text:`Private conversation for ${task.id}`}]);
  const fulfill=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  await page.route('**/v1/tasks**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method(),body=method==='POST'?request.postDataJSON():undefined;
    tasks.calls.push({path,method,body,headers:request.headers()});
    if(path==='/v1/tasks'){
      if(method==='GET')return fulfill(route,{tasks:tasks.records});
      const task={id:randomUUID(),...body,status:body.startImmediately===false?'pending':'running',botName:'Ada'};tasks.records.push(task);tasks.messages.set(task.id,[]);
      return fulfill(route,{task},201);
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
  const login=async()=>{
    await page.goto(fixture.url);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});
    await page.locator('#tasks-nav').click();await page.getByRole('region',{name:'Global tasks'}).waitFor();await page.locator('.timber-tasks-card').first().waitFor();
  };
  const open=async id=>{await page.locator(`.timber-tasks-card[data-task-id="${id}"]`).click();await page.locator('.timber-tasks-detail h2').filter({hasText:tasks.records.find(item=>item.id===id).title}).waitFor();};
  const back=()=>page.getByRole('button',{name:'Back to tasks'}).click();
  try {await work({page,tasks,fixture,login,open,back});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);
    assert.ok(tasks.calls.every(call=>call.headers['x-timber-client']==='console'&&!call.headers.authorization),'task requests reuse authenticated console transport');
  }finally{for(const gate of tasks.readGates.values())gate.resolve();tasks.sendGate?.resolve();await context.close();await fixture.close();}
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
  assert.equal(await page.getByRole('combobox',{name:'Assigned bot',exact:true}).inputValue(),'');
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isDisabled(),true);
  fixture.state.bots=bots;await page.getByRole('button',{name:'Refresh bots',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.timber-tasks-create select')?.value===id,BOT_A);
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isEnabled(),true);
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
