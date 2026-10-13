import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

// Execute the actual client orchestration source with inert mounts/DOM, not a
// separately maintained implementation. These are deterministic operation-count
// tests; browser/layout coverage belongs to the console integration suite.
const source = await readFile(new URL('../../apps/console/console.js', import.meta.url), 'utf8');
function harness() {
  const elements = new Map(), frames = new Map(), timers = new Map(), models = [], activityModels = [], agentModels = [];
  let nextId = 0;
  const node = () => ({children: [], dataset: {}, style: {setProperty() {}}, value: '', hidden: false, classList: {add() {}, remove() {}, toggle() {}},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector() {return null;}, replaceChildren(...items) {this.children = items;},
    append(...items) {for (const item of items) {item.parent = this; this.children.push(item);}}, prepend(item) {item.parent = this; this.children.unshift(item);},
    remove() {if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);}, get lastElementChild() {return this.children.at(-1);},
  });
  const document = {getElementById(id) {if (!elements.has(id)) elements.set(id, node()); return elements.get(id);}, createElement: node,
    querySelector: () => node(), querySelectorAll: () => [], addEventListener() {}, body: node(), documentElement: node(), hidden: false};
  const context = vm.createContext({document, window: {addEventListener() {}}, localStorage: {getItem() {return null;}},
    matchMedia: () => ({matches: false, addEventListener() {}}), innerHeight: 800, location: {hash: '', pathname: '/', search: '', origin: 'https://test.invalid'},
    AbortController, AbortSignal, DOMException, URL, URLSearchParams, console,
    mountChat: () => ({update: value => models.push(value), clear() {}, setDock() {}}),
    mountToolActivity: () => ({update: value => activityModels.push(value), clear() {}, setActive() {}}),
    mountAgents: () => ({update: value => agentModels.push(value), clear() {}, setActive() {}}),
    mountModelPicker: () => ({update() {}}),
    modelUsage: () => ({routes: []}), modelBillingView: () => ({label:'Usage unknown',preview:{},rows:[]}),
    createDesktopViewer: () => ({disconnect() {}, setActive() {}}), mountWorkspaceExplorer: () => ({clear() {}}),
    agentColor: () => 'blue', modelBadgeLabel: () => 'M', hasBotMention: () => false, canRetryAdmission: run => run.admissionRetryable,
    requestAnimationFrame: fn => {const id = ++nextId; frames.set(id, fn); return id;}, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => {const id = ++nextId; timers.set(id, {fn, delay}); return id;}, clearTimeout: id => timers.delete(id), setInterval: () => ++nextId, clearInterval() {},
  });
  const instrumented = source.replace(/^import .*;\n/gm, '').replace('  void restoreSession();', '  globalThis.pipelineEval = code => eval(code);');
  vm.runInContext(instrumented, context, {filename: 'console.js'});
  const run = code => context.pipelineEval(code);
  run(`authenticated = true; selected = {id:'bot-a',name:'Bot A',model:'test',instructions:''};`);
  return {run, models, activityModels, agentModels, frames, timers, flushFrame() {for (const fn of [...frames.values()]) fn();},
    flushFallback() {for (const {fn, delay} of [...timers.values()]) if (delay === 100) fn();}};
}
const runRecord = (id = 'run-a', status = 'running', extra = {}) => ({id, botId: 'bot-a', status, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:01.000Z', ...extra});
const message = (id, extra = {}) => ({id, botId: 'bot-a', runId: 'run-a', role: 'assistant', text: id, createdAt: '2026-10-01T00:00:00.000Z', ...extra});
function event(h, id, type, data, runId = 'run-a', version = 0) {
  h.run(`recordEvent(${JSON.stringify({id, type, data, runId, createdAt: '2026-10-01T00:00:02.000Z'})}, ${version});`);
}

test('10,000 retained messages/events: draft-only updates reuse history projections and do not rescan process history', () => {
  const h = harness();
  h.run(`messages = Array.from({length:10000},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',runId:'r'+i,text:'Message '+i}));
    globalThis.processReads=0; events=Array.from({length:10000},(_,i)=>({id:i,type:'tool.completed',runId:'r'+i,get data(){globalThis.processReads++;return {toolCallId:'t'+i,result:{status:'completed',output:'retained output '+i,token:'redacted'}};}}));
    indexMessages(); globalThis.firstIndex=messageIds; processRunIds(); renderMessages();`);
  const first = h.models.at(-1), reads = h.run('globalThis.processReads');
  assert.equal(first.messages.length, 10000); assert.equal(first.events.length, 10000);
  assert.equal(first.events[0].data.result.token, '[hidden]'); assert.equal(first.events[9999].data.result.output, 'retained output 9999');
  h.run(`for(let i=0;i<200;i++){drafts.set(selected.id,'draft '+i); indexMessages(); processRunIds(); renderMessages();}`);
  const last = h.models.at(-1);
  for (const key of ['messages', 'events', 'runs', 'approvals', 'connections', 'deliveries', 'draftMentions', 'acceptedImageIds', 'compactions']) assert.equal(last[key], first[key], `${key} remains referentially stable`);
  assert.equal(h.run('globalThis.processReads'), reads, 'zero history data reads across 200 draft updates');
  assert.equal(h.run('messageIds===globalThis.firstIndex'), true, 'message index is not rebuilt');
  assert.equal(last.draft, 'draft 199');
  h.run(`events.push({id:10001,type:'tool.completed',runId:'new',data:{result:{status:'completed',output:'new output'}}});renderMessages();`);
  assert.notEqual(h.models.at(-1).events, first.events);
  assert.equal(h.models.at(-1).events[0], first.events[0], 'old event objects are not re-redacted');
  assert.equal(h.models.at(-1).events.length, 10001, 'no history is truncated');
  assert.equal(h.run('globalThis.processReads'), reads, 'appending a projection reads only the newly appended event');
});

test('1000 streamed deltas apply synchronously in order but update the conversation once per frame', () => {
  const h = harness();
  h.run(`mergeRun(${JSON.stringify(runRecord())}); activeRunIds.add('run-a');`);
  for (let id = 1; id <= 1000; id++) event(h, id, 'message.delta', {delta: String(id) + ','});
  assert.equal(h.run('cursor'), 1000);
  assert.equal(h.run("streamDrafts.get('run-a')"), Array.from({length:1000}, (_, i) => `${i + 1},`).join(''));
  assert.equal(h.models.length, 0); assert.equal(h.frames.size, 1);
  h.flushFrame();
  assert.equal(h.models.length, 1); assert.equal(h.activityModels.length, 1);
  assert.equal(h.models[0].stream.text, h.run("streamDrafts.get('run-a')"));
  assert.equal(h.frames.size, 0); assert.equal([...h.timers.values()].filter(item => item.delay === 100).length, 0);
  assert.equal(h.run("$('activity-list').children.length"), 200, 'only the existing diagnostic log is capped');
});

test('mixed replay burst coalesces runs/agents/messages while process ownership and cancellation remain correct', () => {
  const h = harness();
  h.run(`mergeRun(${JSON.stringify(runRecord())}); activeRunIds.add('run-a');`);
  event(h, 1, 'tool.started', {toolCallId: 'tool-a', toolName: 'exec'});
  event(h, 2, 'subagent.created', {subagent: {id: 'agent-a', name: 'A', status: 'running', updatedAt: '2026-10-01T00:00:01Z'}});
  event(h, 3, 'process.updated', {processId: 'process-a', result: {status: 'running'}});
  event(h, 4, 'runtime.snapshot', {busy: true, partialText: 'Recovered'});
  event(h, 5, 'message.delta', {delta: ' + delta'});
  event(h, 6, 'run.updated', {run: runRecord('run-a', 'cancelled', {updatedAt: '2026-10-01T00:00:03.000Z'})});
  event(h, 7, 'message.delta', {delta: 'late cancelled text'});
  assert.equal(h.run('streamDrafts.size'), 0); assert.equal(h.run("processRunIds().has('run-a')"), true);
  h.flushFrame();
  assert.equal(h.models.length, 1); assert.equal(h.agentModels.length, 1);
  assert.equal(h.models[0].stream, null); assert.equal(h.models[0].runs[0].status, 'cancelled');
  assert.equal(h.run("stoppableRun.id"), 'run-a', 'background process still has an explicit Stop owner');
  event(h, 8, 'process.updated', {processId: 'process-a', result: {status: 'completed'}}); h.flushFrame();
  assert.equal(h.run('processRunIds().size'), 0); assert.equal(h.run('stoppableRun'), null);
});

test('snapshot replacement, replay deduplication, retry and finalized message preserve stream correctness', () => {
  const h = harness();
  h.run(`mergeRun(${JSON.stringify(runRecord())});activeRunIds.add('run-a');`);
  event(h, 1, 'message.delta', {delta: 'obsolete partial'});
  event(h, 2, 'runtime.snapshot', {busy: true, partialText: 'recovery partial'});
  event(h, 2, 'message.delta', {delta: 'duplicate replay'});
  event(h, 3, 'message.delta', {delta: ' suffix'});
  assert.equal(h.run("streamDrafts.get('run-a')"), 'recovery partial suffix');
  event(h, 4, 'run.retrying', {}); assert.equal(h.run('streamDrafts.size'), 0);
  event(h, 5, 'runtime.snapshot', {busy: false, partialText: 'not busy'}); assert.equal(h.run('streamDrafts.size'), 0);
  event(h, 6, 'message.delta', {delta: 'new partial'});
  const final = message('final-answer');
  event(h, 7, 'message.created', {message: final}); event(h, 8, 'message.created', {message: final});
  assert.equal(h.run('messages.length'), 1); assert.equal(h.run('streamedMessages.size'), 1); assert.equal(h.run('streamDrafts.size'), 0);
  h.flushFrame(); assert.equal(h.models.length, 1); assert.equal(h.models[0].messages[0].id, 'final-answer'); assert.equal(h.models[0].stream, null);
});

test('hidden-tab fallback settles updates; cancelled/stale generations never publish another bot state', () => {
  const h = harness();
  h.run(`mergeRun(${JSON.stringify(runRecord())});activeRunIds.add('run-a');`);
  event(h, 1, 'message.delta', {delta: 'hidden update'}); h.flushFallback();
  assert.equal(h.models.length, 1); assert.equal(h.frames.size, 0);
  event(h, 2, 'message.delta', {delta: 'old bot update'});
  h.run(`cancelStreamRender();generation++;selected={id:'bot-b',name:'Bot B'};messages=[];events=[];runs=new Map();streamDrafts=new Map();`);
  h.flushFrame(); h.flushFallback(); assert.equal(h.models.length, 1);
  event(h, 3, 'message.delta', {delta: 'stale generation'}, 'run-a', 0);
  assert.equal(h.run('cursor'), 2); assert.equal(h.frames.size, 0);
  h.run(`renderMessages();`);
  assert.equal(h.models.at(-1).bot.id, 'bot-b'); assert.equal(h.models.at(-1).messages.length, 0); assert.equal(h.models.at(-1).events.length, 0);
});

test('unchanged REST snapshots preserve message/run identities and in-flight SSE messages', async () => {
  const h = harness(), old = message('old-answer');
  h.run(`messages=[${JSON.stringify(old)}];mergeRun(${JSON.stringify(runRecord())});renderMessages();`);
  const before = h.models.at(-1);
  h.run(`request=async()=>({messages:[${JSON.stringify(old)}]});`);
  await h.run('loadMessages()');
  assert.equal(h.models.at(-1).messages, before.messages);
  assert.equal(h.run(`mergeRun(${JSON.stringify(runRecord())})`), false);
  h.run('renderMessages()'); assert.equal(h.models.at(-1).runs, before.runs);
  event(h, 1, 'message.created', {message: message('newer-sse')}); h.flushFrame();
  await h.run('loadMessages()');
  assert.deepEqual(Array.from(h.models.at(-1).messages, item => item.id), ['old-answer', 'newer-sse']);
  assert.equal(h.models.at(-1).messages[0], before.messages[0]);
  const changed = {...old, text: 'server correction'};
  h.run(`request=async()=>({messages:[${JSON.stringify(changed)},${JSON.stringify(message('newer-sse'))}]});`);
  await h.run('loadMessages()');
  assert.equal(h.models.at(-1).messages[0].text, 'server correction'); assert.notEqual(h.models.at(-1).messages[0], before.messages[0]);
  assert.equal(h.run('streamedMessages.size'), 0);
});

test('indexes and process cache invalidate for parent changes, approvals, appends, and bot reset', () => {
  const h = harness();
  h.run(`messages=[${JSON.stringify(message('user-1', {role:'user'}))},${JSON.stringify(message('user-2', {role:'user'}))}];indexMessages();`);
  assert.equal(h.run("userMessagesByRun.get('run-a').id"), 'user-1', 'same first user request as find()');
  assert.equal(h.run('latestConversationMessage.id'), 'user-2');
  h.run(`appendMessage(${JSON.stringify(message('latest'))});`); assert.equal(h.run('latestConversationMessage.id'), 'latest');
  h.run(`mergeRun(${JSON.stringify(runRecord('child', 'running', {parentRunId:'parent'}))});approvals=[{runId:'child',result:{processId:'p',status:'running'}}];`);
  assert.equal(h.run("processRunIds().has('parent')"), true);
  h.run(`mergeRun(${JSON.stringify(runRecord('child', 'running', {parentRunId:'new-parent',updatedAt:'2026-10-01T00:00:03Z'}))});`);
  assert.equal(h.run("processRunIds().has('parent')"), false); assert.equal(h.run("processRunIds().has('new-parent')"), true);
  h.run(`approvals=[{runId:'child',result:{processId:'p',status:'completed'}}];`); assert.equal(h.run('processRunIds().size'), 0);
  h.run(`generation++;messages=[];events=[];approvals=[];runs.clear();indexMessages();`);
  assert.equal(h.run('messageIds.size'), 0); assert.equal(h.run('runValues().length'), 0); assert.equal(h.run('processRunIds().size'), 0);
});

test('archive loads one page on reader demand, retaining chronological order and every loaded message across refreshes', async () => {
  const h = harness();
  h.run(`globalThis.historyCalls=[];request=async path=>{globalThis.historyCalls.push(path);if(path.endsWith('before=4'))return {messages:[{id:'m2',role:'assistant',text:'two'},{id:'m3',role:'assistant',text:'three'}],nextCursor:'2'};if(path.endsWith('before=2'))return {messages:[{id:'m1',role:'user',text:'oldest'}],nextCursor:null};return {messages:[{id:'m4',role:'assistant',text:'four'},{id:'m5',role:'assistant',text:'newest'}],nextCursor:'4'};};`);
  await h.run('loadMessages()');
  assert.deepEqual(Array.from(h.models.at(-1).messages,item=>item.id),['m4','m5']);
  assert.equal(h.run('globalThis.historyCalls.length'),1,'opening a long conversation never drains the archive');
  await h.run('loadOlderMessages()');
  assert.deepEqual(Array.from(h.models.at(-1).messages,item=>item.id),['m2','m3','m4','m5']);
  assert.equal(h.run('historyState.cursor'),'2','one demand loads exactly one page');
  await h.run('loadOlderMessages()');
  assert.deepEqual(Array.from(h.models.at(-1).messages, item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(h.run('historyState.cursor'), null); assert.equal(h.models.at(-1).historyHasMore, false); assert.equal(h.models.at(-1).historyLoading, false);
  assert.equal(h.run('globalThis.historyCalls.length'), 3, 'the complete archive remains available in bounded pages');
  const before = h.models.at(-1).messages;
  await h.run('loadMessages()');
  assert.equal(h.models.at(-1).messages, before, 'latest-page refresh does not drop or clone archive records');
  assert.equal(h.run('globalThis.historyCalls.length'), 4, 'completed history cursor is not reset by latest refresh');
});

test('in-flight older pages cannot drop SSE or overwrite a newer latest-page correction', async () => {
  const h = harness();
  h.run(`globalThis.latestText='original';globalThis.pageGate=new Promise(resolve=>globalThis.releasePage=resolve);request=async path=>path.includes('before=')?await globalThis.pageGate:{messages:[{id:'m3',role:'assistant',text:globalThis.latestText}],nextCursor:'3'};`);
  await h.run('loadMessages()'); const pending=h.run('loadOlderMessages()'); assert.equal(h.models.at(-1).historyLoading, true);
  event(h, 1, 'message.created', {message: message('sse-final')}); h.flushFrame();
  h.run(`globalThis.latestText='corrected';`); await h.run('loadMessages()');
  h.run(`globalThis.releasePage({messages:[{id:'m1',role:'user',text:'old'},{id:'m2',role:'assistant',text:'middle'},{id:'m3',role:'assistant',text:'stale overlap'}],nextCursor:null});`);
  await pending;
  const result = h.models.at(-1).messages;
  assert.deepEqual(Array.from(result, item => item.id), ['m1', 'm2', 'm3', 'sse-final']);
  assert.equal(result[2].text, 'corrected'); assert.equal(h.run('streamedMessages.size'), 1);
});

test('archive failure retains its cursor and loaded records; retry resumes, and old-generation pages never cross bot boundaries', async () => {
  const h = harness();
  h.run(`globalThis.failPage=true;request=async path=>{if(!path.includes('before='))return {messages:[{id:'latest',role:'assistant',text:'latest'}],nextCursor:'2'};if(globalThis.failPage)throw new Error('network gap');return {messages:[{id:'oldest',role:'user',text:'oldest'}],nextCursor:null};};`);
  await h.run('loadMessages()'); await h.run('loadOlderMessages()');
  assert.equal(h.run('historyState.cursor'), '2'); assert.equal(h.models.at(-1).messages.length, 1); assert.match(h.models.at(-1).historyError, /network gap/);
  assert.ok(h.run('historyState.retryAt')>Date.now(),'failed reads retain bounded backoff without eagerly draining history');
  h.run(`globalThis.failPage=false;historyState.retryAt=0;`); await h.run('loadOlderMessages()');
  assert.equal(h.models.at(-1).messages.length, 2); assert.equal(h.run('historyState.cursor'), null);
  h.run(`resetConversationHistory();messages=[];globalThis.gate=new Promise(resolve=>globalThis.releaseStale=resolve);request=async path=>path.includes('before=')?await globalThis.gate:{messages:[{id:'new-latest',role:'assistant',text:'new-latest'}],nextCursor:'3'};`);
  await h.run('loadMessages()'); const stale = h.run('loadOlderMessages()');
  h.run(`resetConversationHistory();generation++;selected={id:'bot-b',name:'Bot B'};messages=[];globalThis.releaseStale({messages:[{id:'wrong-bot',text:'never visible'}],nextCursor:null});`);
  await stale; assert.equal(h.run('messages.length'), 0); assert.equal(h.run('historyState.loading'), false);
});

test('all compaction receipts, including legacy undated receipts, have stable public projections and bounded polling', async () => {
  const h = harness();
  h.run(`globalThis.contextCalls=0;globalThis.receipts=Array.from({length:25},(_,i)=>({id:'c'+i,reason:i%2?'manual':'threshold',status:'completed',summaryApplied:true,...(i?{createdAt:'2026-10-01T00:00:00Z'}:{}),internalSummary:'not public'}));request=async()=>{globalThis.contextCalls++;return {context:{compactions:globalThis.receipts}};};`);
  await h.run('loadCompactions()');
  const before = h.models.at(-1).compactions;
  assert.equal(before.length, 25); assert.equal(before[0].createdAt, undefined, 'legacy receipt kept without fabricating a timestamp');
  assert.equal(before[0].internalSummary, undefined, 'only contracted public fields enter chat');
  assert.equal([...h.timers.values()].some(item => item.delay === 30000), true);
  await h.run('loadCompactions()'); assert.equal(h.run('globalThis.contextCalls'), 1, 'ordinary refresh burst is throttled');
  await h.run('loadCompactions(0,true)'); assert.equal(h.models.at(-1).compactions, before, 'unchanged context snapshot reuses array');
  h.run(`drafts.set(selected.id,'typing');renderMessages();`); assert.equal(h.models.at(-1).compactions, before);
  h.run(`mergeCompactions([{id:'manual-new',reason:'manual',status:'running',summaryApplied:false}]);renderMessages();scheduleCompactions();`);
  assert.equal(h.models.at(-1).compactions.length, 26); assert.equal([...h.timers.values()].some(item => item.delay === 15000), true);
  h.run(`mergeCompactions([{id:'manual-new',reason:'manual',status:'completed',summaryApplied:true}]);mergeCompactions([{id:'manual-new',reason:'manual',status:'running',summaryApplied:false}]);`);
  assert.equal(h.run("compactions.at(-1).status"), 'completed', 'stale running receipt cannot revert finalized lifecycle');
});

test('history stops in hidden tabs, resumes on reader demand, and rejects non-advancing cursors', async () => {
  const h = harness();
  h.run(`document.hidden=true;globalThis.historyCalls=0;request=async path=>{globalThis.historyCalls++;return path.includes('before=')?{messages:[{id:'old',role:'user',text:'old'}],nextCursor:null}:{messages:[{id:'new',role:'assistant',text:'new'}],nextCursor:'2'};};`);
  await h.run('loadMessages()');
  assert.equal(h.run('globalThis.historyCalls'), 1, 'background archive network work pauses while hidden');
  assert.equal(h.run('historyState.cursor'), '2');
  h.run('document.hidden=false;'); await h.run('loadOlderMessages()');
  assert.equal(h.models.at(-1).messages.length, 2); assert.equal(h.run('globalThis.historyCalls'), 2);
  h.run(`resetConversationHistory();messages=[];globalThis.historyCalls=0;request=async path=>{globalThis.historyCalls++;return {messages:[],nextCursor:'2'};};`);
  await h.run('loadMessages()'); await h.run('loadOlderMessages()');
  assert.equal(h.run('globalThis.historyCalls'), 2, 'a broken cursor cannot cause an unbounded request loop');
  assert.match(h.models.at(-1).historyError, /cursor did not advance/i);
});

test('manual context callback publishes a receipt immediately and invalidates an older in-flight context snapshot', async () => {
  const h = harness();
  h.run(`globalThis.contextGate=new Promise(resolve=>globalThis.releaseContext=resolve);request=async path=>path.endsWith('/compact')?{compaction:{id:'manual-live',reason:'manual',status:'completed',summaryApplied:true,summaryCreatedAt:'2026-10-01T00:00:02Z'}}:await globalThis.contextGate;`);
  const pending = h.run('loadCompactions()');
  await h.run(`contextRequest('bot-a','/context/compact',{method:'POST'})`);
  assert.equal(h.models.at(-1).compactions[0].id, 'manual-live');
  h.run(`globalThis.releaseContext({context:{compactions:[]}});`); await pending;
  assert.equal(h.models.at(-1).compactions.length, 1, 'older GET snapshot never removes the new manual receipt');
  assert.equal(h.models.at(-1).compactions[0].status, 'completed');
});

test('bounded SSE bootstrap replaces partials at its cursor boundary and never resurrects terminal streams',()=>{
  const h=harness();
  h.run(`mergeRun(${JSON.stringify(runRecord())});activeRunIds.add('run-a');streamDrafts.set('run-a','truncated tail');cursor=40;mergeRun(${JSON.stringify(runRecord('done','completed'))});`);
  event(h,40,'stream.snapshot',{latestEventId:40,partials:[{runId:'run-a',text:'Complete current partial'},{runId:'done',text:'must stay absent'}],historyTruncated:true,nextCursor:15});h.flushFrame();
  assert.equal(h.models.at(-1).stream.text,'Complete current partial');
  assert.equal(h.run("streamDrafts.has('done')"),false);
  assert.equal(h.run('eventHistory.cursor'),15);
  assert.equal(h.models.at(-1).historyHasMore,true);
  event(h,41,'message.delta',{delta:' plus next'});h.flushFrame();
  assert.equal(h.models.at(-1).stream.text,'Complete current partial plus next');
  event(h,40,'stream.snapshot',{latestEventId:40,partials:[]});h.flushFrame();
  assert.equal(h.models.at(-1).stream.text,'Complete current partial plus next','stale bootstrap cannot clear newer live text');
});

test('task status pills deduplicate replay and ignore stale versions while keeping stable metadata',async()=>{
  const h=harness(),task={id:'task-a',title:'Build the app',botId:'bot-a',createdByBotId:'bot-a',sourceRunId:'run-a',status:'queued',statusVersion:1,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
  h.run(`messages=[${JSON.stringify(message('source',{role:'user'}))}];`);
  // Status events update tasks already verified by the owner-scoped listing.
  h.run(`request=async()=>({tasks:[${JSON.stringify(task)}]});`);
  await h.run('loadConversationTasks()');
  event(h,1,'task.updated',{task});h.flushFrame();
  assert.equal(h.models.at(-1).tasks.length,1);
  const first=h.models.at(-1).tasks;
  event(h,2,'task.updated',{task});h.flushFrame();assert.equal(h.run('visibleConversationTasks()'),first,'unchanged replay retains the projection');
  h.run(`request=async()=>({tasks:[${JSON.stringify(task)},${JSON.stringify({...task,id:'task-b',title:'Verify the app'})}]});`);
  await h.run('loadConversationTasks()');
  event(h,3,'task.updated',{task:{...task,id:'task-b',title:'Verify the app'}});h.flushFrame();
  event(h,4,'task.updated',{task:{...task,status:'completed',statusVersion:3,updatedAt:'2026-10-01T00:00:03Z'}});h.flushFrame();
  event(h,5,'task.updated',{task:{...task,status:'running',statusVersion:2,updatedAt:'2026-10-01T00:00:04Z'}});h.flushFrame();
  assert.equal(h.run('conversationTasks[0].status'),'completed','lower durable version never reverses terminal status');
  assert.deepEqual(Array.from(h.models.at(-1).tasks,item=>item.id),['task-a','task-b'],'sibling pills retain their order when one status changes');
  h.run(`request=async()=>({tasks:[${JSON.stringify(task)},${JSON.stringify({...task,id:'task-b',title:'Verify the app'})},${JSON.stringify({...task,id:'nested',sourceTaskId:'task-a'})}]});`);
  await h.run('loadConversationTasks()');
  assert.equal(h.models.at(-1).tasks.length,2,'nested tasks belong to their originating task chat');
  assert.equal(h.models.at(-1).tasks[0].createdAt,task.createdAt,'status changes keep their original timeline anchor');
  event(h,6,'task.updated',{task:{...task,status:'running',statusVersion:4,updatedAt:'2026-09-30T00:00:00Z'}});h.flushFrame();
  assert.equal(h.models.at(-1).tasks[0].status,'running','authoritative newer versions survive clock skew');
});

test('activity archive reads one page, keeps live events, and rejects pages from an old bot generation',async()=>{
  const h=harness();
  h.run(`eventHistory.cursor=40;events=[{id:45,type:'tool.completed',data:{output:'live'}}];globalThis.eventReads=0;request=async path=>{globalThis.eventReads++;return {events:[{id:20,type:'tool.completed',data:{output:'older'}},{id:21,type:'message.delta',data:{delta:'archived'}}],nextCursor:20};};`);
  await h.run('loadOlderEvents()');
  assert.equal(h.run('globalThis.eventReads'),1);assert.deepEqual(Array.from(h.run('events'),item=>item.id),[20,45]);assert.equal(h.run('eventHistory.cursor'),20);
  h.run(`globalThis.eventGate=new Promise(resolve=>globalThis.releaseEvents=resolve);request=async()=>globalThis.eventGate;`);
  const pending=h.run('loadOlderEvents()');
  h.run(`resetConversationHistory();generation++;selected={id:'bot-b'};events=[];globalThis.releaseEvents({events:[{id:1,type:'tool.completed',data:{output:'wrong bot'}}],nextCursor:null});`);
  await pending;assert.equal(h.run('events.length'),0,'old activity never crosses bot boundaries');
});

test('closed diagnostic disclosures do not serialize large event payloads during stream updates',()=>{
  const h=harness();
  h.run(`globalThis.payloadReads=0;for(let i=1;i<=200;i++)recordEvent({id:i,type:'heartbeat',data:{get output(){globalThis.payloadReads++;return 'large output'.repeat(20000)}},createdAt:'2026-10-01T00:00:00Z'},0);`);
  assert.equal(h.run('globalThis.payloadReads'),0,'unused event JSON stays lazy');
  assert.equal(h.run("$('activity-list').children.length"),200);
});

test('completed task pills follow the loaded message archive without rendering thousands of unseen historical tasks',()=>{
  const h=harness();
  h.run(`messages=[{id:'recent',runId:'r9999',role:'user',text:'recent request'}];conversationTasks=Array.from({length:10000},(_,i)=>({id:'t'+i,title:'Task '+i,sourceRunId:'r'+i,status:'completed'}));conversationTasks.push({id:'active',sourceRunId:'old-active',status:'running'});renderMessages();`);
  assert.deepEqual(Array.from(h.models.at(-1).tasks,item=>item.id),['t9999','active']);
  const first=h.models.at(-1).tasks;
  h.run(`drafts.set(selected.id,'typing');renderMessages();`);assert.equal(h.models.at(-1).tasks,first,'typing does not rescan task archive');
  h.run(`mergeMessagePage([{id:'older',runId:'r9998',role:'user',text:'older request'}],true);renderMessages();`);
  assert.deepEqual(Array.from(h.models.at(-1).tasks,item=>item.id),['t9998','t9999','active'],'loading original messages restores their completed task pills');
});
