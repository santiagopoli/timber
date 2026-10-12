import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
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
  const tasks={records:statuses.map(status=>({id:`task-${status}`,title:`Task ${status}`,description:`Independent ${status} work`,botId:BOT_A,botName:'Ada',status,createdAt:'2026-10-05T10:00:00.000Z'})),messages:new Map(),events:new Map(),approvals:new Map(),calls:[],readGates:new Map(),reads:[],sendGate:null,sendError:false};
  for(const task of tasks.records)tasks.messages.set(task.id,[{id:`${task.id}-reply`,role:'assistant',text:`Private conversation for ${task.id}`}]);
  const fulfill=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  await page.route('**/v1/tasks**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),body=method==='POST'?request.postDataJSON():undefined;
    tasks.calls.push({path,method,body,query:url.searchParams.toString(),headers:request.headers()});
    if(path==='/v1/tasks'){
      if(method==='GET')return fulfill(route,{tasks:tasks.records});
      const task={id:randomUUID(),...body,status:body.startImmediately===false?'pending':'running',botName:'Ada'};tasks.records.push(task);tasks.messages.set(task.id,[]);
      return fulfill(route,{task},201);
    }
    const [,id,tail='']=/^\/v1\/tasks\/([^/]+)(.*)$/.exec(path)||[],task=tasks.records.find(item=>item.id===id);
    if(!task)return fulfill(route,{error:{code:'not_found',message:'Task not found.'}},404);
    if(method==='GET'){
      if(tail==='/events'){
        const source=tasks.events.get(id)||[];
        if(url.searchParams.get('format')!=='json'){const after=Number(url.searchParams.get('after')||0),events=source.filter(event=>event.id>after);return route.fulfill({status:200,contentType:'text/event-stream',body:(after?events:events.slice(-100)).map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')});}
        const before=Number(url.searchParams.get('before')||Infinity),eligible=source.filter(event=>event.id<before),events=eligible.slice(-100);
        return fulfill(route,{events,nextCursor:eligible.length>100?String(events[0].id):null});
      }
      if(tail==='/runs')return fulfill(route,{runs:[{id:`${id}-run`,status:task.status==='cancelled'?'cancelled':['completed','failed'].includes(task.status)?task.status:'running'}]});
      // Snapshot before the delayed response, as a real stale read would do.
      const source=tasks.messages.get(id)||[],before=Number(url.searchParams.get('before')||source.length+1),eligible=source.filter((message,index)=>(message.row||index+1)<before),messages=eligible.slice(-Number(url.searchParams.get('limit')||100));
      const payload=structuredClone(tail==='/messages'?{messages,nextCursor:eligible.length>messages.length?String(messages[0].row||source.indexOf(messages[0])+1):null}:tail==='/approvals'?{approvals:tasks.approvals.get(id)||[]}:{task});
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
  await page.getByRole('button',{name:'Refresh task',exact:true}).click();await page.locator('.timber-tasks-detail h2').filter({hasText:'Task running'}).waitFor();
  assert.equal(await page.getByLabel('Message this task').inputValue(),'Keep this new draft');assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-running');
}));

test('global tasks: a delayed polling response cannot replace a new task view',async()=>withTasks(async({page,tasks,login,open,back})=>{
  await page.clock.install();await login();await open('task-running');
  const gate=deferred();tasks.readGates.set('task-running',gate);
  const before=tasks.reads.length,polling=page.waitForRequest(request=>request.method()==='GET'&&new URL(request.url()).pathname==='/v1/tasks/task-running/messages');await page.clock.fastForward(8001);await polling;
  assert.ok(tasks.reads.slice(before).some(read=>read.id==='task-running'),'real task interval initiates polling');
  await back();await open('task-waiting_connection');gate.resolve();
  await page.getByRole('button',{name:'Refresh task',exact:true}).click();
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
  const refreshBots=async()=>{await page.locator('#bots-nav').click();await page.getByRole('button',{name:'Refresh bots',exact:true}).click();await page.locator('#tasks-nav').click();};
  fixture.state.bots=bots;await refreshBots();
  await page.waitForFunction(id=>document.querySelector('.timber-tasks-create select')?.value===id,BOT_A);
  assert.equal(await page.getByRole('button',{name:'Create task',exact:true}).isEnabled(),true);
  fixture.state.bots=bots.filter(bot=>bot.id===BOT_B);await refreshBots();
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

for(const width of [320,390,1440])test(`global tasks: pill views and task rows share bot styling at ${width}px`,async()=>withTasks(async({page,login,fixture})=>{
  await login();assert.equal(await page.locator('#tasks-nav').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#bots-nav').getAttribute('aria-pressed'),'false');
  if(width>=761){assert.equal(await page.locator('#bot-search').isVisible(),false,'Tasks replaces the bot list in the same desktop sidecolumn');assert.equal(await page.locator('#tasks-sidebar-root .timber-tasks-overview').isVisible(),true);}
  const row=page.locator('.timber-tasks-card').first();assert.ok((await row.getAttribute('class')).includes('bot-item'));
  const geometry=await page.evaluate(()=>{const box=selector=>document.querySelector(selector).getBoundingClientRect();return {title:box('.timber-tasks-overview h2').left,search:box('.timber-tasks-search').left,row:box('.timber-tasks-card').left,avatar:box('.timber-task-avatar').left,scroll:document.documentElement.scrollWidth,width:innerWidth}});
  assert.ok(Math.max(geometry.title,geometry.search,geometry.row,geometry.avatar)-Math.min(geometry.title,geometry.search,geometry.row,geometry.avatar)<=1,'task title, search, rows and avatar share an axis');assert.ok(geometry.scroll<=geometry.width+1);
  await page.getByRole('searchbox',{name:'Search tasks',exact:true}).fill('waiting connection');assert.equal(await page.locator('.timber-tasks-card').count(),0);
  await page.getByRole('searchbox',{name:'Search tasks',exact:true}).fill('connection');assert.equal(await page.locator('.timber-tasks-card').count(),1);await page.getByRole('searchbox',{name:'Search tasks',exact:true}).fill('');
  await mkdir('/tmp/timber-task-views',{recursive:true});await page.screenshot({path:`/tmp/timber-task-views/tasks-${width}.png`});
  if(width<761)await page.locator('.timber-tasks-topbar').getByRole('button',{name:'Bots',exact:true}).click();else await page.locator('#bots-nav').click();
  await page.locator('#bot-search').waitFor({state:'visible'});assert.equal(await page.locator('#bots-nav').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#tasks-nav').getAttribute('aria-pressed'),'false');
  assert.ok(fixture.state.calls.every(call=>!call.path.includes('/computer/exec')),'view switching never starts computer work');
},width));

test('global tasks: long task history starts bounded and commands stay inspectable through archival pages and live updates',async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-running',runId=`${id}-run`;
  tasks.messages.set(id,Array.from({length:320},(_,index)=>({id:`history-${index+1}`,row:index+1,role:index%2?'assistant':'user',text:`Task message ${index+1}`})));
  const events=Array.from({length:240},(_,index)=>({id:index+1,type:index%2?'tool.completed':'tool.started',botId:BOT_A,runId,createdAt:'2026-10-05T10:00:00.000Z',data:{operationId:`task-command-${Math.floor(index/2)}`,toolCallId:`native-command-${Math.floor(index/2)}`,actionType:'exec',input:{command:`printf command-${Math.floor(index/2)}`},...(index%2?{result:{status:'completed',output:`Output ${Math.floor(index/2)}`,exitCode:0}}:{})}}));tasks.events.set(id,events);
  await login();await open(id);assert.equal(await page.locator('[data-task-message-id]').count(),100);
  const activity=page.getByRole('region',{name:'Task activity'});await activity.locator('[data-activity-tool-operation-id="task-command-119"]').waitFor();
  assert.equal(await activity.locator('[data-activity-tool-operation-id]').count(),50,'the newest 100 events render 50 merged commands');assert.equal(await activity.locator('[data-activity-tool-operation-id="task-command-0"]').count(),0);
  await page.getByRole('button',{name:'Load older messages',exact:true}).click();await page.getByLabel('Task conversation').getByText('Task message 121',{exact:true}).waitFor();assert.equal(await page.locator('[data-task-message-id]').count(),200);
  await activity.getByRole('button',{name:'Older activity',exact:true}).click();await activity.locator('[data-activity-tool-operation-id="task-command-20"]').waitFor();assert.equal(await activity.locator('[data-activity-tool-operation-id]').count(),50,'archive pages replace the activity viewport');
  await activity.getByRole('button',{name:'Older activity',exact:true}).click();const original=activity.locator('[data-activity-tool-operation-id="task-command-0"]');await original.waitFor();await original.locator('summary').click();assert.ok((await original.innerText()).includes('printf command-0'));assert.ok((await original.innerText()).includes('Output 0'));
  await activity.getByRole('button',{name:'Latest activity',exact:true}).click();await activity.locator('[data-activity-tool-operation-id="task-command-119"]').waitFor();assert.equal(await original.count(),0);
  events.push({id:241,type:'tool.completed',botId:BOT_A,runId,createdAt:'2026-10-05T10:01:00.000Z',data:{operationId:'live-command',actionType:'exec',input:{command:'printf live-task'},result:{status:'completed',output:'Live task output',exitCode:0}}});await activity.locator('[data-activity-tool-operation-id="live-command"]').waitFor();
  assert.ok((await activity.innerText()).includes('Live task output'));assert.equal(await activity.locator('[data-activity-tool-operation-id="task-command-119"]').count(),1,'live updates retain one merged effect');
  assert.ok(tasks.calls.filter(call=>call.path.endsWith('/messages')&&call.method==='GET').every(call=>new URLSearchParams(call.query).get('limit')==='100'));
  assert.ok(tasks.calls.filter(call=>call.path.endsWith('/events')&&new URLSearchParams(call.query).get('format')==='json').every(call=>new URLSearchParams(call.query).get('limit')==='100'));
  await page.screenshot({path:'/tmp/timber-task-views/task-activity-1440.png'});
}));

test('global tasks: closing task view aborts its polling and opening a deep link restores the isolated task',async()=>withTasks(async({page,tasks,login,open})=>{
  await page.clock.install();await login();await open('task-running');
  assert.ok(page.url().endsWith('#tasks&task=task-running'),'selected tasks have a shareable fragment without credentials');
  await page.locator('#bots-nav').click();const count=tasks.calls.length;await page.clock.fastForward(24001);await page.evaluate(()=>Promise.resolve());assert.equal(tasks.calls.length,count,'hidden task view has no polls or streams');
  await page.evaluate(()=>{location.hash='tasks&task=task-waiting_connection'});await page.locator('.timber-tasks-detail h2').filter({hasText:'Task waiting_connection'}).waitFor();assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-waiting_connection');assert.equal(await page.getByLabel('Task conversation').getByText('Private conversation for task-running',{exact:true}).count(),0);
}));

test('global tasks: browser Back follows task history without inserting new navigation entries',async()=>withTasks(async({page,login,open})=>{
  await login();const overview=page.url();await open('task-running');assert.ok(page.url().endsWith('#tasks&task=task-running'));
  await page.goBack();await page.locator('.timber-tasks-overview').waitFor();await page.locator('.timber-tasks-detail').waitFor({state:'detached'});assert.equal(page.url(),overview);
  await page.goForward();await page.locator('.timber-tasks-detail h2').filter({hasText:'Task running'}).waitFor();assert.ok(page.url().endsWith('#tasks&task=task-running'));
  await page.goBack();await page.locator('.timber-tasks-detail').waitFor({state:'detached'});assert.equal(page.url(),overview);
}));

test('global tasks: new bots enable task creation by default and an explicit owner opt-out is submitted',async()=>withTasks(async({page,fixture,login})=>{
  await login();await page.locator('#bots-nav').click();await page.locator('#new-bot').click();const permission=page.locator('#bot-dialog').getByLabel('Allow creating tasks',{exact:true});assert.equal(await permission.isChecked(),true);
  await page.locator('#bot-name').fill('Small chat only');await permission.uncheck();await page.getByRole('button',{name:'Create bot',exact:true}).click();await page.locator('#bot-dialog').waitFor({state:'hidden'});
  const creation=fixture.state.calls.find(call=>call.method==='POST'&&call.path==='/v1/bots'&&call.body.name==='Small chat only');assert.equal(creation.body.allowTaskCreation,false,'opt-out is preserved in server policy');
  await page.locator('#new-bot').click();assert.equal(await permission.isChecked(),true,'the next new-bot form returns to its reviewed default');await page.getByRole('button',{name:'Close create bot',exact:true}).click();
}));

test('global tasks: live chat receives partial snapshots and final receipts without replaying the whole transcript',async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-running',runId=`${id}-run`,events=[{id:4,botId:BOT_A,type:'stream.snapshot',createdAt:'2026-10-05T10:00:00.000Z',data:{latestEventId:4,partials:[{runId,text:'Working on '}]}},{id:5,botId:BOT_A,runId,type:'message.delta',createdAt:'2026-10-05T10:00:00.000Z',data:{delta:'this task.'}}];tasks.events.set(id,events);
  await login();await open(id);const stream=page.locator(`[data-task-stream-run-id="${runId}"]`);await stream.getByText('Working on this task.',{exact:true}).waitFor();assert.equal(await page.locator('[data-task-message-id]').count(),1,'partial text does not rewrite archived messages');
  events.push({id:6,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:01.000Z',data:{message:{id:'live-final-task-answer',botId:BOT_A,runId,role:'assistant',text:'Finished this task.',createdAt:'2026-10-05T10:00:01.000Z'}}});
  await page.locator('[data-task-message-id="live-final-task-answer"]').getByText('Finished this task.',{exact:true}).waitFor();await stream.waitFor({state:'detached'});assert.equal(await page.locator('[data-task-message-id="live-final-task-answer"]').count(),1);
  const firstLive=tasks.calls.find(call=>call.path.endsWith('/events')&&new URLSearchParams(call.query).get('format')!=='json');assert.equal(new URLSearchParams(firstLive.query).get('after'),'0');assert.equal(new URLSearchParams(firstLive.query).get('tail'),'100');
}));

for(const width of [390,1440])test(`global tasks: chat opens at newest, follows live answers, and preserves older readers at ${width}px`,async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-running',runId=`${id}-run`;tasks.messages.set(id,Array.from({length:240},(_,index)=>({id:`scroll-message-${index+1}`,row:index+1,role:'assistant',text:`Task update ${index+1}\n\nSecond line for update ${index+1}.`})));tasks.events.set(id,[]);
  await login();await open(id);const scroll=page.locator('[data-task-scroll]');await page.waitForFunction(()=>{const node=document.querySelector('[data-task-scroll]');return node&&node.scrollHeight>node.clientHeight&&node.scrollHeight-node.clientHeight-node.scrollTop<=4});
  const events=tasks.events.get(id);events.push({id:1,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:01.000Z',data:{message:{id:'scroll-live-first',role:'assistant',text:'Newest streamed task answer.\n\nMore answer detail.'}}});await page.locator('[data-task-message-id="scroll-live-first"]').waitFor();await page.waitForFunction(()=>{const node=document.querySelector('[data-task-scroll]');return node&&node.scrollHeight-node.clientHeight-node.scrollTop<=4});
  await scroll.hover();await page.mouse.wheel(0,-100000);await page.waitForFunction(()=>document.querySelector('[data-task-scroll]').scrollTop===0);
  const anchor=page.locator('[data-task-message-id="scroll-message-141"]');const before=await anchor.evaluate(node=>node.getBoundingClientRect().top);await page.getByRole('button',{name:'Load older messages',exact:true}).click();await page.getByLabel('Task conversation').getByText('Task update 41',{exact:true}).waitFor();
  await page.waitForFunction(top=>Math.abs(document.querySelector('[data-task-message-id="scroll-message-141"]').getBoundingClientRect().top-top)<3,before);
  const retained=await scroll.evaluate(node=>node.scrollTop);events.push({id:2,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:02.000Z',data:{message:{id:'scroll-live-second',role:'assistant',text:'Another later task answer.'}}});await page.locator('[data-task-message-id="scroll-live-second"]').waitFor();assert.ok(Math.abs(await scroll.evaluate(node=>node.scrollTop)-retained)<=3,'later answers do not pull the reader away from older messages');
  assert.ok(await scroll.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop)>100,'older reader stays away from latest');
},width));
