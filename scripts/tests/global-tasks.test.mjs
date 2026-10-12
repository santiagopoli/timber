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
const taskChat=page=>page.locator('.timber-tasks-detail #messages');
const taskDraft=page=>page.locator('.timber-tasks-detail #message');
const taskSend=page=>page.locator('.timber-tasks-detail #message-form').getByRole('button',{name:'Send message',exact:true});
const taskScroll='[data-task-id] #messages';
const fixtureDate='2026-10-05T10:00:00.000Z';
const normalizedRun=(task,run={})=>({id:`${task.id}-run`,botId:task.botId,operationId:`task-start:${task.id}`,status:task.status==='cancelled'?'cancelled':['completed','failed','waiting_approval','waiting_connection'].includes(task.status)?task.status:'running',createdAt:fixtureDate,updatedAt:fixtureDate,...run});
const normalizedMessage=(task,message,index=0)=>({id:randomUUID(),botId:task.botId,role:'assistant',text:'',createdAt:new Date(Date.parse(fixtureDate)+(message.row||index+1)).toISOString(),...message});
const normalizedEvent=(task,event)=>({...event,botId:task.botId,createdAt:event.createdAt||fixtureDate,data:{...event.data,...(event.data.message?{message:normalizedMessage(task,{runId:event.runId,createdAt:event.createdAt||fixtureDate,...event.data.message})}:{}),...(event.data.run?{run:normalizedRun(task,event.data.run)}:{})}});
const taskDetails=async page=>{await page.locator('.timber-tasks-detail').getByRole('button',{name:'Task details',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Task details',exact:true});await dialog.waitFor();return dialog;};
async function withTasks(work,width=1440,colorScheme='light') {
  browser??=await chromium.launch({headless:true,
    ...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{}),
  });
  const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height:900},colorScheme});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
  const tasks={records:statuses.map(status=>({id:`task-${status}`,title:`Task ${status}`,description:`Independent ${status} work`,botId:BOT_A,botName:'Ada',status,createdAt:'2026-10-05T10:00:00.000Z'})),messages:new Map(),events:new Map(),runs:new Map(),agents:new Map(),agentMessages:new Map(),approvals:new Map(),calls:[],readGates:new Map(),reads:[],sendGate:null,sendError:false};
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
      if(tail==='/keychain')return fulfill(route,{entries:[],requests:[]});
      if(tail==='/connections')return fulfill(route,{connections:[]});
      if(tail==='/context')return fulfill(route,{context:{automatic:true,estimatedTokens:0,activeEntries:0,contextWindow:200000,compactions:[]}});
      if(tail==='/agents')return fulfill(route,{agents:tasks.agents.get(id)||[],delegations:[]});
      const agentMessages=/^\/agents\/([^/]+)\/messages$/.exec(tail);if(agentMessages)return fulfill(route,{messages:tasks.agentMessages.get(`${id}:${agentMessages[1]}`)||[]});
      if(tail==='/events'){
        const source=(tasks.events.get(id)||[]).map(event=>normalizedEvent(task,event));
        if(url.searchParams.get('format')!=='json'){const after=Number(url.searchParams.get('after')||0),events=source.filter(event=>event.id>after);return route.fulfill({status:200,contentType:'text/event-stream',body:(after?events:events.slice(-100)).map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')});}
        const before=Number(url.searchParams.get('before')||Infinity),eligible=source.filter(event=>event.id<before),events=eligible.slice(-100);
        return fulfill(route,{events,nextCursor:eligible.length>100?String(events[0].id):null});
      }
      if(tail==='/runs'){const runs=(tasks.runs.get(id)||(['pending','queued'].includes(task.status)?[]:[normalizedRun(task)])).map(run=>normalizedRun(task,run));return fulfill(route,{runs,activeRuns:runs.filter(run=>['queued','running','waiting_approval','waiting_connection'].includes(run.status)),nextCursor:null});}
      // Snapshot before the delayed response, as a real stale read would do.
      const source=tasks.messages.get(id)||[],before=Number(url.searchParams.get('before')||source.length+1),eligible=source.filter((message,index)=>(message.row||index+1)<before),messages=eligible.slice(-Number(url.searchParams.get('limit')||100));
      const payload=structuredClone(tail==='/messages'?{messages:messages.map(message=>normalizedMessage(task,message,source.indexOf(message))),nextCursor:eligible.length>messages.length?String(messages[0].row||source.indexOf(messages[0])+1):null}:tail==='/approvals'?{approvals:(tasks.approvals.get(id)||[]).map(approval=>({botId:task.botId,runId:`${task.id}-run`,operationId:approval.id,createdAt:fixtureDate,...approval}))}:{task});
      const read={id,tail,finished:false};tasks.reads.push(read);
      if(tasks.readGates.has(id))await tasks.readGates.get(id).promise;
      try{return await fulfill(route,payload);}catch(error){if(!request.failure())throw error;}finally{read.finished=true;}
    }
    const agentRoute=/^\/agents\/([^/]+)\/(messages|cancel)$/.exec(tail);
    if(agentRoute){const [,agentId,action]=agentRoute,agent=(tasks.agents.get(id)||[]).find(item=>item.id===agentId);if(!agent)return fulfill(route,{error:{code:'not_found',message:'Agent not found.'}},404);if(action==='cancel'){agent.status='cancelled';agent.updatedAt=new Date().toISOString();return fulfill(route,{agent});}const key=`${id}:${agentId}`,messages=tasks.agentMessages.get(key)||[];messages.push({id:randomUUID(),role:'user',text:body.text,createdAt:new Date().toISOString()});tasks.agentMessages.set(key,messages);return fulfill(route,{run:normalizedRun(task,{id:randomUUID(),subagentId:agentId,operationId:body.operationId,status:'running'})},202);}
    if(tail==='/continue'){
      if(!['completed','failed'].includes(task.status))return fulfill(route,{error:{code:'task_cancelled',message:'This task cannot continue.'}},409);
      const previous=(tasks.runs.get(id)||[normalizedRun(task)]),run=normalizedRun(task,{id:randomUUID(),operationId:body.operationId,status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});tasks.runs.set(id,[...previous,run]);task.status='running';tasks.messages.get(id).push(normalizedMessage(task,{id:randomUUID(),runId:run.id,role:'user',text:body.text,createdAt:run.createdAt}));return fulfill(route,{task,run},202);
    }
    if(tail==='/messages'){
      if(tasks.sendGate)await tasks.sendGate.promise;
      if(tasks.sendError)return fulfill(route,{error:{code:'unavailable',message:'Send response unavailable.'}},503);
      const run=normalizedRun(task,{id:randomUUID(),operationId:body.operationId,status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});tasks.runs.set(id,[...(tasks.runs.get(id)||[normalizedRun(task)]),run]);tasks.messages.get(id).push(normalizedMessage(task,{id:randomUUID(),runId:run.id,role:'user',text:body.text,createdAt:run.createdAt}));return fulfill(route,{run},202);
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
    if(!await page.locator('#tasks-nav').isVisible())await page.locator('#toggle-bots').click();await page.locator('#tasks-nav').click();await page.getByRole('region',{name:'Global tasks'}).waitFor();await page.locator('.timber-tasks-card').first().waitFor();
  };
  const open=async id=>{await page.locator(`.timber-tasks-card[data-task-id="${id}"]`).click();await page.locator('.timber-tasks-detail h1').filter({hasText:tasks.records.find(item=>item.id===id).title}).waitFor();await taskChat(page).waitFor();};
  const back=async()=>{const button=page.getByRole('button',{name:'Back to tasks',exact:true});if(await button.isVisible())await button.click();else await page.locator('#tasks-nav').click();};
  try {await work({page,tasks,fixture,login,open,back});assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.failures,[]);
    assert.ok(tasks.calls.every(call=>call.headers['x-timber-client']==='console'&&!call.headers.authorization),'task requests reuse authenticated console transport');
  }finally{for(const gate of tasks.readGates.values())gate.resolve();tasks.sendGate?.resolve();await context.close();await fixture.close();}
}

for(const width of [390,1440])test(`global tasks: default auto-start, explicit pending override, filters behind an icon and dedicated chat at ${width}px`,async()=>withTasks(async({page,tasks,fixture,login,open,back})=>{
  await login();
  const filters=page.getByRole('group',{name:'Filter tasks by status'}),cards=page.locator('.timber-tasks-card');
  assert.equal(await cards.count(),9,'All retains completed, failed and cancelled');
  const filterButton=page.getByRole('button',{name:'Filter tasks',exact:true});
  assert.equal(await filters.count(),0,'filters do not occupy a separate row in the list');
  await filterButton.click();await filters.getByRole('button',{name:'Active',exact:true}).click();assert.equal(await cards.count(),5);assert.equal(await filters.count(),0,'selection closes the popover');
  assert.equal(await filterButton.getAttribute('data-filtered'),'true');
  await filterButton.click();assert.equal(await filters.getByRole('button',{name:'Active',exact:true}).getAttribute('aria-pressed'),'true');
  await filters.getByRole('button',{name:'Pending',exact:true}).click();assert.deepEqual(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId)),['task-pending']);
  await filterButton.click();await filters.getByRole('button',{name:'Completed',exact:true}).click();assert.deepEqual(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId)),['task-completed']);
  await filterButton.click();await filters.getByRole('button',{name:'All',exact:true}).click();assert.equal(await filterButton.getAttribute('data-filtered'),'false');
  await filterButton.click();await page.keyboard.press('Escape');assert.equal(await filters.count(),0);assert.equal(await filterButton.evaluate(node=>node===document.activeElement),true,'Escape returns focus to the icon');
  await open('task-running');
  assert.equal(await taskChat(page).innerText().then(value=>value.includes('Private conversation for task-running')),true);
  assert.equal(await taskChat(page).innerText().then(value=>value.includes('Organize the research notes')),false,'ordinary bot transcript is not copied into task chat');
  await taskDraft(page).fill('Task-only follow-up');await taskSend(page).click();
  await taskChat(page).getByText('Task-only follow-up',{exact:true}).waitFor();
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`).length,0,'task send never steers the ordinary bot');
  assert.equal(fixture.state.messages.get(BOT_A).some(message=>message.text==='Task-only follow-up'),false);
  await back();await page.getByRole('button',{name:'New task',exact:true}).click();
  assert.equal(await page.getByLabel('Start immediately').isChecked(),true);
  assert.equal(await page.getByLabel('Description',{exact:true}).getAttribute('maxlength'),'32000','description respects the server bound');
  await page.getByLabel('Title',{exact:true}).fill('Default immediate task');await page.getByLabel('Description',{exact:true}).fill('Work in the assigned bot computer');
  await page.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h1').filter({hasText:'Default immediate task'}).waitFor();
  assert.equal(tasks.calls.filter(call=>call.path==='/v1/tasks'&&call.method==='POST').at(-1).body.startImmediately,true);
  await back();await page.getByRole('button',{name:'New task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Explicit pending task');await page.getByLabel('Start immediately').uncheck();
  await page.getByRole('button',{name:'Create task',exact:true}).click();await page.locator('.timber-tasks-detail h1').filter({hasText:'Explicit pending task'}).waitFor();
  assert.equal(tasks.calls.filter(call=>call.path==='/v1/tasks'&&call.method==='POST').at(-1).body.startImmediately,false);
  const pendingDetails=await taskDetails(page);assert.equal(await pendingDetails.getByRole('button',{name:'Start task',exact:true}).isVisible(),true);
  await pendingDetails.getByRole('button',{name:'Start task',exact:true}).click();await page.keyboard.press('Escape');await taskDraft(page).waitFor();
  await page.locator('.timber-tasks-detail .bot-header').getByRole('button',{name:'Cancel task',exact:true}).waitFor();
  const bounds=await page.getByRole('region',{name:'Global tasks'}).evaluate(node=>({right:node.getBoundingClientRect().right,scroll:node.scrollWidth,width:node.clientWidth}));assert.ok(bounds.right<=width+1&&bounds.scroll<=bounds.width+1,'task layout fits viewport');
},width));

test('global tasks: approval decisions are task-scoped, expired/executing approvals cannot be approved',async()=>withTasks(async({page,tasks,fixture,login,open,back})=>{
  const approval=(id,status='pending',expiresAt=new Date(Date.now()+60000).toISOString())=>({id,status,action:{type:'exec',command:'printf task-only'},expiresAt});
  tasks.approvals.set('task-waiting_approval',[approval('task-approval'),approval('expired-approval','pending','2020-01-01T00:00:00.000Z'),approval('executing-approval','executing')]);
  fixture.state.approvals.set(BOT_A,[approval('ordinary-bot-approval')]);
  await login();await open('task-waiting_approval');const panel=taskChat(page);
  await panel.locator('[data-timeline-approval="task-approval"]').waitFor();
  assert.equal(await panel.locator('[data-timeline-approval="expired-approval"]').getByRole('button').count(),0);
  assert.equal(await panel.locator('[data-timeline-approval="executing-approval"]').getByRole('button').count(),0);
  assert.equal(await panel.locator('[data-timeline-approval="ordinary-bot-approval"]').count(),0);
  await panel.locator('[data-timeline-approval="task-approval"]').getByRole('button',{name:'Approve',exact:true}).click();
  await panel.locator('[data-timeline-approval="task-approval"]').getByRole('button',{name:'Approve',exact:true}).waitFor({state:'detached'});
  assert.deepEqual(tasks.calls.find(call=>call.method==='POST'&&call.path.endsWith('/approvals/task-approval')).body,{decision:'approve'});
  assert.equal(fixture.state.approvals.get(BOT_A)[0].status,'pending');
  tasks.approvals.set('task-running',[approval('denied-task-approval')]);await back();await open('task-running');
  await panel.locator('[data-timeline-approval="denied-task-approval"]').getByRole('button',{name:'Deny',exact:true}).click();await panel.locator('[data-timeline-approval="denied-task-approval"]').getByRole('button',{name:'Deny',exact:true}).waitFor({state:'detached'});
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path.includes('/approvals/')).length,2);
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path.includes('/approvals/')).length,0,'no decision is posted to the assigned bot conversation');
}));

test('global tasks: retry identities include task ID and late sends cannot clear a replacement task draft',async()=>withTasks(async({page,tasks,login,open,back})=>{
  await login();await open('task-running');tasks.sendError=true;
  const send=async()=>{await taskDraft(page).fill('Identical follow-up');const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname.endsWith('/messages'));await taskSend(page).click();await response;await taskChat(page).locator('.timber-delivery-error').filter({hasText:'Send response unavailable.'}).waitFor();};
  await send();await send();const first=tasks.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));
  assert.equal(first[0].body.operationId,first[1].body.operationId,'same failed task message preserves retry identity');
  await back();await open('task-waiting_connection');await send();
  const sends=tasks.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));assert.notEqual(sends[0].body.operationId,sends[2].body.operationId,'same text in another task gets a distinct identity');
  tasks.sendError=false;tasks.sendGate=deferred();
  const dispatched=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/messages'));
  await taskSend(page).click();await dispatched;
  await back();await open('task-running');await taskDraft(page).fill('Keep this new draft');const sent=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/messages'));tasks.sendGate.resolve();await sent;
  const details=await taskDetails(page);await details.getByRole('button',{name:'Refresh task',exact:true}).click();await page.keyboard.press('Escape');await page.locator('.timber-tasks-detail h1').filter({hasText:'Task running'}).waitFor();
  assert.equal(await taskDraft(page).inputValue(),'Keep this new draft');assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-running');
}));

test('global tasks: a delayed polling response cannot replace a new task view',async()=>withTasks(async({page,tasks,login,open,back})=>{
  await page.clock.install();await login();await open('task-running');
  const gate=deferred();tasks.readGates.set('task-running',gate);
  const before=tasks.reads.length,polling=page.waitForRequest(request=>request.method()==='GET'&&new URL(request.url()).pathname==='/v1/tasks/task-running/messages');await page.clock.fastForward(8001);await polling;
  assert.ok(tasks.reads.slice(before).some(read=>read.id==='task-running'),'real task interval initiates polling');
  await back();await open('task-waiting_connection');gate.resolve();
  const details=await taskDetails(page);await details.getByRole('button',{name:'Refresh task',exact:true}).click();await page.keyboard.press('Escape');
  await taskChat(page).getByText('Private conversation for task-waiting_connection',{exact:true}).waitFor();
  assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-waiting_connection');
  assert.equal(await taskChat(page).getByText('Private conversation for task-running',{exact:true}).count(),0);
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
  await taskSend(page).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).count(),0);
  await taskDraft(page).fill('New instructions, not an old action retry');
  await taskSend(page).click();
  await taskChat(page).getByText('New instructions, not an old action retry',{exact:true}).waitFor();
  const calls=tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/task-${status}/continue`);
  assert.equal(calls.length,1);assert.equal(typeof calls[0].body.operationId,'string');assert.equal(calls[0].body.text,'New instructions, not an old action retry');
  assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/task-${status}/start`).length,0);
  assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`).length,0);
  await back();await open('task-cancelled');assert.ok(!await taskDraft(page).count()||!await taskDraft(page).isEditable(),'cancelled tasks do not accept new task instructions');const details=await taskDetails(page);assert.equal(await details.getByText('Cancelled tasks stay stopped. Create a new task to work again.',{exact:true}).isVisible(),true);await page.keyboard.press('Escape');
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
  await page.locator('#bots-nav').click();
  await page.locator('#bot-search').waitFor({state:'visible'});assert.equal(await page.locator('#bots-nav').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#tasks-nav').getAttribute('aria-pressed'),'false');
  assert.ok(fixture.state.calls.every(call=>!call.path.includes('/computer/exec')),'view switching never starts computer work');
},width));

for(const [width,colorScheme] of [[320,'light'],[390,'light'],[1024,'light'],[1440,'light'],[390,'dark'],[1440,'dark']])test(`global tasks: the entire list keeps the Bots shell and geometry at ${width}px ${colorScheme}`,async()=>withTasks(async({page,tasks,login,open,back})=>{
  const geometry=async selector=>page.locator(selector).evaluate(root=>{
    const sample=node=>{const style=getComputedStyle(node),box=node.getBoundingClientRect();return {box:{left:box.left,top:box.top,width:box.width,height:box.height},style:Object.fromEntries(['backgroundColor','fontSize','fontWeight','lineHeight','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','gap'].map(key=>[key,style[key]]))}};
    return {shell:sample(root),brand:sample(document.querySelector('.brand')),toggle:sample(root.querySelector('.timber-view-toggle')),heading:sample(root.querySelector('.sidebar-heading:not([style])')),search:sample(root.querySelector('.search-field')),row:sample(root.querySelector('.bot-item')),avatar:sample(root.querySelector('.bot-item .avatar')),name:sample(root.querySelector('.bot-item .bot-name')).style,preview:sample(root.querySelector('.bot-item .bot-preview')).style};
  });
  await login();await page.locator('#bots-nav').click();await page.locator('#bot-search').waitFor();
  if(!await page.locator('#bot-search').isVisible())await page.locator('#toggle-bots').click();
  await page.locator('#bot-list .bot-model-badge').first().filter({hasText:'GPT-6.1 Sol'}).waitFor();
  await page.evaluate(()=>{globalThis.__listBrand=document.querySelector('.brand');globalThis.__listToggle=document.querySelector('.global-navigation')});
  const bot=await geometry('#bot-sidebar');
  await mkdir('/tmp/timber-list-parity',{recursive:true});await page.screenshot({path:`/tmp/timber-list-parity/bots-${width}-${colorScheme}.png`});
  await page.locator('#tasks-nav').click();await page.locator('.timber-tasks-card').first().waitFor();if(width>=761){await open('task-pending');await page.locator('.timber-tasks-card').first().evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));}
  const task=await page.locator('#bot-sidebar').evaluate(root=>{
    // Only the content source changes: the shell and navigation are retained.
    const sample=node=>{const style=getComputedStyle(node),box=node.getBoundingClientRect();return {box:{left:box.left,top:box.top,width:box.width,height:box.height},style:Object.fromEntries(['backgroundColor','fontSize','fontWeight','lineHeight','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','gap'].map(key=>[key,style[key]]))}};
    const content=root.querySelector('.timber-tasks-overview');return {shell:sample(root),brand:sample(document.querySelector('.brand')),toggle:sample(root.querySelector('.timber-view-toggle')),heading:sample(content.querySelector('.sidebar-heading')),search:sample(content.querySelector('.search-field')),row:sample(content.querySelector('.bot-item')),avatar:sample(content.querySelector('.avatar')),name:sample(content.querySelector('.bot-name')).style,preview:sample(content.querySelector('.bot-preview')).style};
  });
  assert.deepEqual(task,bot,'brand, toggle, heading, search, rows and avatars match Bots in position and style');
  assert.equal(await page.evaluate(()=>globalThis.__listBrand===document.querySelector('.brand')&&globalThis.__listToggle===document.querySelector('.global-navigation')),true,'same actual brand and navigation nodes');
  assert.equal(await page.locator('.brand').isVisible(),true);assert.equal(await page.locator('#settings-button').isVisible(),true);
  assert.equal(await page.getByRole('group',{name:'Filter tasks by status'}).count(),0);
  assert.equal(await page.locator('.timber-tasks-topbar,.timber-task-assignee,.timber-task-status').count(),0,'no second navigation or extra metadata rows');
  assert.equal(await page.locator('.timber-task-avatar .timber-model-badge').count(),0,'same uncluttered avatar as Bots');
  await page.screenshot({path:`/tmp/timber-list-parity/tasks-${width}-${colorScheme}.png`});
  await open('task-completed');if(width<761){assert.equal(await page.locator('.brand').isVisible(),false);await back();assert.equal(await page.locator('.brand').isVisible(),true);assert.equal(await page.locator('#tasks-nav').getAttribute('aria-pressed'),'true');}
  else await back();
  await page.getByRole('button',{name:'Filter tasks',exact:true}).click();await page.getByRole('group',{name:'Filter tasks by status'}).getByRole('button',{name:'Completed',exact:true}).click();
  assert.equal(await page.locator('.timber-tasks-card').count(),1);await page.locator('#bots-nav').click();await page.locator('#tasks-nav').click();assert.equal(await page.locator('.timber-tasks-card').count(),1,'filter survives switching views');
  await page.locator('#settings-button').click();await page.locator('#settings-dialog').waitFor();await page.locator('#settings-dialog').getByRole('button',{name:'Close settings',exact:true}).click();
  assert.ok(tasks.calls.every(call=>call.method==='GET'),'navigation and filters do not execute tasks');
},width,colorScheme));

test('global tasks: long task history starts bounded and commands stay inspectable through archival pages and live updates',async()=>withTasks(async({page,tasks,login,open,back})=>{
  const id='task-running',runId=`${id}-run`;
  tasks.messages.set(id,Array.from({length:320},(_,index)=>({id:`history-${index+1}`,row:index+1,role:index%2?'assistant':'user',text:`Task message ${index+1}`})));
  const events=Array.from({length:240},(_,index)=>({id:index+1,type:index%2?'tool.completed':'tool.started',botId:BOT_A,runId,createdAt:'2026-10-05T10:00:00.000Z',data:{operationId:`task-command-${Math.floor(index/2)}`,toolCallId:`native-command-${Math.floor(index/2)}`,actionType:'exec',input:{command:`printf command-${Math.floor(index/2)}`},...(index%2?{result:{status:'completed',output:`Output ${Math.floor(index/2)}`,exitCode:0}}:{})}}));tasks.events.set(id,events);
  await login();await open(id);assert.equal(await taskChat(page).locator('[data-message-id]').count(),100);
  const activity=taskChat(page);await activity.locator('[data-tool-operation-id="task-command-119"]').waitFor();
  assert.equal(await activity.locator('[data-tool-operation-id]').count(),50,'the newest 100 events render 50 merged commands');assert.equal(await activity.locator('[data-tool-operation-id="task-command-0"]').count(),0);
  await page.getByRole('button',{name:'Load earlier history',exact:true}).click();await taskChat(page).getByText('Task message 121',{exact:true}).waitFor();assert.equal(await taskChat(page).locator('[data-message-id]').count(),200);
  await activity.locator('[data-tool-operation-id="task-command-20"]').waitFor();assert.equal(await activity.locator('[data-tool-operation-id]').count(),100,'the shared history request also restores archived commands');
  await page.getByRole('button',{name:'Load earlier history',exact:true}).click();const original=activity.locator('[data-tool-operation-id="task-command-0"]');await original.waitFor();await original.locator('summary').click();assert.ok((await original.innerText()).includes('printf command-0'));assert.ok((await original.innerText()).includes('Output 0'));
  assert.equal(await activity.locator('[data-tool-operation-id]').count(),120,'explicit paging retains all 120 command identities without duplicates');
  await back();await open(id);await activity.locator('[data-tool-operation-id="task-command-119"]').waitFor();assert.equal(await original.count(),0,'reopening restores a bounded newest page');
  events.push({id:241,type:'tool.completed',botId:BOT_A,runId,createdAt:'2026-10-05T10:01:00.000Z',data:{operationId:'live-command',actionType:'exec',input:{command:'printf live-task'},result:{status:'completed',output:'Live task output',exitCode:0}}});await activity.locator('[data-tool-operation-id="live-command"]').waitFor();
  assert.ok((await activity.innerText()).includes('Live task output'));assert.equal(await activity.locator('[data-tool-operation-id="task-command-119"]').count(),1,'live updates retain one merged effect');
  assert.ok(tasks.calls.filter(call=>call.path.endsWith('/messages')&&call.method==='GET').every(call=>new URLSearchParams(call.query).get('limit')==='100'));
  assert.ok(tasks.calls.filter(call=>call.path.endsWith('/events')&&new URLSearchParams(call.query).get('format')==='json').every(call=>new URLSearchParams(call.query).get('limit')==='100'));
  await page.screenshot({path:'/tmp/timber-task-views/task-activity-1440.png'});
}));

test('global tasks: closing task view aborts its polling and opening a deep link restores the isolated task',async()=>withTasks(async({page,tasks,login,open})=>{
  await page.clock.install();await login();await open('task-running');
  assert.ok(page.url().endsWith('#tasks&task=task-running'),'selected tasks have a shareable fragment without credentials');
  await page.locator('#bots-nav').click();const count=tasks.calls.length;await page.clock.fastForward(24001);await page.evaluate(()=>Promise.resolve());assert.equal(tasks.calls.length,count,'hidden task view has no polls or streams');
  await page.evaluate(()=>{location.hash='tasks&task=task-waiting_connection'});await page.locator('.timber-tasks-detail h1').filter({hasText:'Task waiting_connection'}).waitFor();assert.equal(await page.locator('.timber-tasks-detail').getAttribute('data-task-id'),'task-waiting_connection');assert.equal(await taskChat(page).getByText('Private conversation for task-running',{exact:true}).count(),0);
}));

test('global tasks: browser Back follows task history without inserting new navigation entries',async()=>withTasks(async({page,login,open})=>{
  await login();const overview=page.url();await open('task-running');assert.ok(page.url().endsWith('#tasks&task=task-running'));
  await page.goBack();await page.locator('.timber-tasks-overview').waitFor();await page.locator('.timber-tasks-detail').waitFor({state:'detached'});assert.equal(page.url(),overview);
  await page.goForward();await page.locator('.timber-tasks-detail h1').filter({hasText:'Task running'}).waitFor();assert.ok(page.url().endsWith('#tasks&task=task-running'));
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
  await login();await open(id);const stream=taskChat(page).locator('#streaming-message');await stream.getByText('Working on this task.',{exact:true}).waitFor();assert.equal(await taskChat(page).locator('[data-message-id]').count(),1,'partial text does not rewrite archived messages');
  events.push({id:6,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:01.000Z',data:{message:{id:'live-final-task-answer',botId:BOT_A,runId,role:'assistant',text:'Finished this task.',createdAt:'2026-10-05T10:00:01.000Z'}}});
  await page.locator('[data-message-id="live-final-task-answer"]').getByText('Finished this task.',{exact:true}).waitFor();await stream.waitFor({state:'detached'});assert.equal(await page.locator('[data-message-id="live-final-task-answer"]').count(),1);
  const firstLive=tasks.calls.find(call=>call.path.endsWith('/events')&&new URLSearchParams(call.query).get('format')!=='json');assert.equal(new URLSearchParams(firstLive.query).get('after'),'0');assert.equal(new URLSearchParams(firstLive.query).get('tail'),'100');
  assert.ok(tasks.calls.some(call=>call.path.endsWith('/events')&&new URLSearchParams(call.query).get('after')==='5'),'reconnecting resumes after the authoritative snapshot and later delta rather than replaying the transcript');
}));

for(const width of [390,1440])test(`global tasks: chat opens at newest, follows live answers, and preserves older readers at ${width}px`,async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-running',runId=`${id}-run`;tasks.messages.set(id,Array.from({length:240},(_,index)=>({id:`scroll-message-${index+1}`,row:index+1,role:'assistant',text:`Task update ${index+1}\n\nSecond line for update ${index+1}.`})));tasks.events.set(id,[]);
  await login();await open(id);const scroll=page.locator('.timber-tasks-detail #messages');await page.waitForFunction(()=>{const node=document.querySelector('.timber-tasks-detail #messages');return node&&node.scrollHeight>node.clientHeight&&node.scrollHeight-node.clientHeight-node.scrollTop<=4});
  const events=tasks.events.get(id);events.push({id:1,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:01.000Z',data:{message:{id:'scroll-live-first',role:'assistant',text:'Newest streamed task answer.\n\nMore answer detail.'}}});await page.locator('[data-message-id="scroll-live-first"]').waitFor();await page.waitForFunction(()=>{const node=document.querySelector('.timber-tasks-detail #messages');return node&&node.scrollHeight-node.clientHeight-node.scrollTop<=4});
  // Position the reader without also firing shared-chat automatic pagination;
  // this case verifies the explicit history button's preserved DOM anchor.
  await scroll.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'))});await page.waitForFunction(()=>document.querySelector('.timber-tasks-detail #messages').scrollTop===0);
  const anchor=page.locator('[data-message-id="scroll-message-141"]');const before=await anchor.evaluate(node=>node.getBoundingClientRect().top);await page.getByRole('button',{name:'Load earlier history',exact:true}).click();await taskChat(page).getByText('Task update 41',{exact:true}).waitFor();
  await page.waitForFunction(top=>Math.abs(document.querySelector('[data-message-id="scroll-message-141"]').getBoundingClientRect().top-top)<3,before);
  const retained=await scroll.evaluate(node=>node.scrollTop);events.push({id:2,botId:BOT_A,runId,type:'message.created',createdAt:'2026-10-05T10:00:02.000Z',data:{message:{id:'scroll-live-second',role:'assistant',text:'Another later task answer.'}}});await page.locator('[data-message-id="scroll-live-second"]').waitFor();assert.ok(Math.abs(await scroll.evaluate(node=>node.scrollTop)-retained)<=3,'later answers do not pull the reader away from older messages');
  assert.ok(await scroll.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop)>100,'older reader stays away from latest');
},width));

test('global tasks: accepted billing failure appears inside its original message with safe details and no implicit retry',async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-failed',runId=`${id}-run`;tasks.runs.set(id,[{id:runId,status:'failed',errorCode:'model_billing_required',error:'Untrusted provider diagnostic fixture.'}]);
  tasks.messages.set(id,[{id:'failed-task-request',runId,role:'user',text:'Prepare this task report.'},{id:'unrelated-task-message',role:'user',text:'Another task instruction.'}]);
  await login();await open(id);const message=page.locator('[data-message-id="failed-task-request"]'),notice=message.locator('[data-run-outcome]');await notice.waitFor();
  assert.ok((await notice.innerText()).includes('The selected model provider requires paid access or available billing credits.'));assert.equal((await taskChat(page).innerText()).includes('Untrusted provider diagnostic fixture.'),false,'allowlisted model diagnostic replaces provider prose');
  assert.equal(await page.locator('[data-run-outcome]').count(),1);assert.equal(await page.locator('.timber-task-outcome:not(.timber-message-notice)').count(),0);assert.equal(await page.locator('[data-message-id="unrelated-task-message"] [data-run-outcome]').count(),0);
  await notice.getByText('Details',{exact:true}).click();assert.equal(await notice.locator('code').innerText(),'model_billing_required');assert.equal(await notice.getByRole('button').count(),0,'a diagnostic never authorizes replay');
  const continuation=taskSend(page);assert.equal(await continuation.isVisible(),true,'existing explicit continuation remains available');assert.ok(await continuation.evaluate(node=>node.scrollWidth<=node.clientWidth),'existing Continue label fits its control');assert.equal(tasks.calls.filter(call=>call.method==='POST').length,0);
  await mkdir('/tmp/timber-task-views',{recursive:true});await page.screenshot({path:'/tmp/timber-task-views/task-inline-failure-390.png'});
},390));

test('global tasks: failure remains visible until its original older message is loaded, then moves into that bubble once',async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-failed',runId=`${id}-run`;tasks.runs.set(id,[{id:runId,status:'interrupted',errorCode:'model_request_failed',error:'The model request failed before an answer completed.'}]);
  tasks.messages.set(id,[{id:'older-failed-task-request',row:1,runId,role:'user',text:'Original archived task request.'},...Array.from({length:100},(_,index)=>({id:`later-task-message-${index+2}`,row:index+2,role:'assistant',text:`Later task update ${index+2}.`}))]);
  await login();await open(id);const fallback=page.locator('.timber-task-outcome:not(.timber-message-notice)');await fallback.waitFor();assert.ok((await fallback.innerText()).includes('Response interrupted'));assert.equal(await page.locator('[data-message-id="older-failed-task-request"]').count(),0);
  await page.getByRole('button',{name:'Load earlier history',exact:true}).click();const original=page.locator('[data-message-id="older-failed-task-request"]');await original.locator('[data-run-outcome]').waitFor();assert.equal(await fallback.count(),0);assert.equal(await page.locator('[data-run-outcome]').count(),1,'history reconciliation leaves one diagnostic');
  assert.equal(await original.locator('[data-run-outcome]').getByRole('button',{name:'Retry sending',exact:true}).count(),0,'an accepted interrupted run does not replay its old message');assert.equal(tasks.calls.filter(call=>call.method==='POST').length,0);
}));

for(const width of [390,1440])test(`global tasks: task messages, composer and header are the bot conversation at ${width}px`,async()=>withTasks(async({page,tasks,fixture,login,open})=>{
  const pairs=[{role:'user',text:'The same request in either conversation.'},{role:'assistant',text:'The same answer in either conversation.'}];
  fixture.state.messages.set(BOT_A,pairs.map((message,index)=>({id:`bot-parity-${message.role}`,botId:BOT_A,createdAt:new Date(Date.parse(fixtureDate)+index).toISOString(),...message})));
  tasks.messages.set('task-completed',pairs.map((message,index)=>({id:`task-parity-${message.role}`,createdAt:new Date(Date.parse(fixtureDate)+index).toISOString(),...message})));
  const geometry=async selector=>page.locator(selector).evaluate(root=>{
    const pick=selector=>{const node=root.querySelector(selector);if(!node)throw new Error(`Missing parity element ${selector}`);const style=getComputedStyle(node);return Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopStyle','backgroundColor'].map(key=>[key,style[key]]));};
    const box=selector=>{const rect=root.querySelector(selector).getBoundingClientRect();return {left:Math.round(rect.left),width:Math.round(rect.width)}};
    return {header:pick('.bot-header'),title:pick('.bot-header h1'),avatar:pick('.bot-header .avatar'),user:pick('.timber-message-user .timber-message-content'),assistant:pick('.timber-message-assistant .timber-message-content'),composer:pick('.timber-composer'),input:pick('#message'),send:pick('#message-form .timber-send'),layout:{header:box('.bot-header'),composer:box('.timber-composer'),conversation:box('#messages')}};
  });
  await login();await page.locator('#bots-nav').click();await page.locator(`#bot-list [data-bot-id="${BOT_A}"]`).click();await page.locator('#bot-workspace [data-message-id="bot-parity-assistant"]').waitFor();const bot=await geometry('#bot-workspace');
  if(!await page.locator('#tasks-nav').isVisible())await page.locator('#mobile-back').click();await page.locator('#tasks-nav').click();await open('task-completed');await taskChat(page).locator('[data-message-id="task-parity-assistant"]').waitFor();const task=await geometry('.timber-tasks-detail');assert.deepEqual(task,bot,'task view uses identical computed conversation/header/composer styles');
  const description=page.locator('.timber-tasks-detail').getByText('Independent completed work',{exact:true});assert.ok(!await description.count()||!await description.isVisible(),'description does not occupy the conversation');assert.equal(await page.getByRole('dialog',{name:'Task details',exact:true}).count(),0);
  const state=page.locator('.timber-tasks-detail [data-task-state]');assert.equal(await state.innerText(),'Completed');const stateSize=await state.evaluate(node=>{const rect=node.getBoundingClientRect();return {width:rect.width,height:rect.height,font:parseFloat(getComputedStyle(node).fontSize)}});assert.ok(stateSize.width<=110&&stateSize.height<=30&&stateSize.font<=13,'task state stays compact in the header');
  await mkdir('/tmp/timber-task-views',{recursive:true});await page.screenshot({path:`/tmp/timber-task-views/task-shared-conversation-${width}.png`});
  const details=await taskDetails(page);await details.getByText('Independent completed work',{exact:true}).waitFor();assert.ok((await details.innerText()).includes('Ada'));await page.keyboard.press('Escape');assert.ok(!await description.count()||!await description.isVisible(),'details close without leaving a second card');
  await taskDraft(page).fill('Continue in this dedicated task.');await taskSend(page).click();await taskChat(page).getByText('Continue in this dedicated task.',{exact:true}).waitFor();assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks/task-completed/continue').length,1);assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path===`/v1/bots/${BOT_A}/messages`).length,0);
  const navigation=await taskDetails(page);await navigation.getByRole('button',{name:'Open bot',exact:true}).click();await page.locator('#bot-workspace').waitFor({state:'visible'});await page.locator('#bot-workspace [data-message-id="bot-parity-assistant"]').waitFor();assert.equal(await page.locator('#bot-workspace [data-message-id]').count(),2,'returning to the assigned bot restores its original isolated conversation');assert.equal((await page.locator('#bot-workspace #messages').innerText()).includes('Continue in this dedicated task.'),false);
},width));

test('global tasks: retrying an earlier failed delivery keeps that receipt after a different message also fails',async()=>withTasks(async({page,tasks,login,open})=>{
  await login();await open('task-running');tasks.sendError=true;
  const send=async value=>{await taskDraft(page).fill(value);const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&new URL(reply.url()).pathname==='/v1/tasks/task-running/messages');await taskSend(page).click();await response;await taskChat(page).locator('.timber-delivery-error').last().getByText('Send response unavailable.',{exact:true}).waitFor();};
  await send('Earlier task instruction.');await send('A different later task instruction.');const receipts=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks/task-running/messages');assert.equal(receipts.length,2);assert.notEqual(receipts[0].body.operationId,receipts[1].body.operationId);
  const earlier=taskChat(page).locator(`[data-operation-id="${receipts[0].body.operationId}"]`),reply=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/v1/tasks/task-running/messages');await earlier.getByRole('button',{name:'Retry sending',exact:true}).click();await reply;
  const retried=tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks/task-running/messages').at(-1);assert.equal(retried.body.operationId,receipts[0].body.operationId,'the earlier receipt remains the idempotency identity');assert.equal(retried.body.text,'Earlier task instruction.');assert.equal(await taskDraft(page).inputValue(),'A different later task instruction.','retry does not overwrite the newer draft');assert.equal(await taskChat(page).locator(`[data-operation-id="${receipts[1].body.operationId}"]`).count(),1,'the later failed message keeps its own receipt');
}));

test('global tasks: shared agent header opens the real task agent conversation and scoped steering/Stop',async()=>withTasks(async({page,tasks,fixture,login,open})=>{
  const id='task-running',agent={id:'task-scout',name:'Scout',task:'Inspect only this task workspace.',parentOperationId:`task-start:${id}`,operationId:'task-scout-operation',status:'running',createdAt:fixtureDate,updatedAt:fixtureDate};tasks.agents.set(id,[agent]);tasks.agentMessages.set(`${id}:${agent.id}`,[{id:'task-scout-answer',role:'assistant',text:'Task-only agent update.',createdAt:fixtureDate}]);
  await login();await open(id);const header=page.locator('.timber-tasks-detail .bot-header');await header.getByRole('button',{name:'Agents 1',exact:true}).click();await page.getByRole('button',{name:'View all agents',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Agents',exact:true});await dialog.waitFor();await dialog.locator(`[data-agent-id="${agent.id}"]`).click();await dialog.getByLabel('Scout conversation').getByText('Task-only agent update.',{exact:true}).waitFor();
  await dialog.getByLabel('Message Scout',{exact:true}).fill('Inspect the next file in this task.');await dialog.getByRole('button',{name:'Send message to Scout',exact:true}).click();await dialog.getByLabel('Scout conversation').getByText('Inspect the next file in this task.',{exact:true}).waitFor();
  const steering=tasks.calls.find(call=>call.method==='POST'&&call.path===`/v1/tasks/${id}/agents/${agent.id}/messages`);assert.equal(steering.body.text,'Inspect the next file in this task.');assert.equal(typeof steering.body.operationId,'string');
  await dialog.getByRole('button',{name:'Stop agent',exact:true}).click();await dialog.getByText('This agent was stopped.',{exact:false}).waitFor();assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/${id}/agents/${agent.id}/cancel`).length,1);assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path===`/v1/tasks/${id}/cancel`).length,0,'agent Stop does not cancel the parent task');assert.equal(fixture.state.calls.filter(call=>call.method==='POST'&&call.path.includes('/agents/')).length,0,'task agent actions never reach the ordinary bot namespace');
}));

test('global tasks: provider connection recovery opens owner Settings from the task message',async()=>withTasks(async({page,tasks,login,open})=>{
  const id='task-failed',record=tasks.records.find(item=>item.id===id),run=normalizedRun(record,{status:'failed',errorCode:'chatgpt_not_connected',error:'Connect ChatGPT before running this bot.'});
  tasks.runs.set(id,[run]);tasks.messages.set(id,[normalizedMessage(record,{id:'task-auth-request',runId:run.id,role:'user',text:'Use this task connection.'})]);
  await login();await open(id);await taskChat(page).getByRole('button',{name:'Open Settings',exact:true}).click();
  await page.locator('#settings-dialog').waitFor({state:'visible'});assert.equal(await page.getByRole('dialog',{name:'Task details',exact:true}).count(),0);
}));

for(const width of [390,1440])test(`queued task keeps its composer writable at ${width}px`,async()=>withTasks(async({page,tasks,login,open})=>{
 await login();await open('task-queued');
 await taskDraft(page).fill('Keep this correction for when the computer is available');
 assert.equal(await taskSend(page).isEnabled(),true);
 await taskSend(page).click();
 await taskChat(page).getByText('Keep this correction for when the computer is available',{exact:true}).waitFor();
 assert.equal(tasks.calls.filter(call=>call.method==='POST'&&call.path==='/v1/tasks/task-queued/messages').length,1);
},width));
