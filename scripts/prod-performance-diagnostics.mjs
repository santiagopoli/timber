// Fixed read-only projections. Never select prompts, arguments, tool output or
// credentials; identifiers used for routing stay inside collectDurable.
export const PERFORMANCE_SCHEMA = "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('runs','submissions','events','botspace_runtime_budget','pi_tasks','pi_entries') ORDER BY name";
export const PERFORMANCE_TASKS = `SELECT t.id,json_extract(t.data,'$.status') AS status,
 json_extract(t.data,'$.createdAt') AS created_at,json_extract(t.data,'$.updatedAt') AS updated_at
 FROM tasks t JOIN bots b ON b.id=json_extract(t.data,'$.botId')
 WHERE lower(json_extract(b.data,'$.name'))='polibot' ORDER BY t.rowid DESC LIMIT 6`;
export const PERFORMANCE_RUNS = `SELECT json_extract(data,'$.createdAt') AS created_at,
 json_extract(data,'$.updatedAt') AS updated_at,json_extract(data,'$.status') AS status,
 json_extract(data,'$.errorCode') AS error_code,
 (SELECT COUNT(*) FROM botspace_runtime_budget b JOIN submissions s ON s.operation_id=b.operation_id WHERE s.run_id=r.id AND b.kind='generation') AS generations,
 (SELECT COUNT(*) FROM botspace_runtime_budget b JOIN submissions s ON s.operation_id=b.operation_id WHERE s.run_id=r.id AND b.kind='tool') AS tools,
 (SELECT COUNT(*) FROM events e WHERE json_extract(e.data,'$.runId')=r.id AND json_extract(e.data,'$.type')='run.retrying') AS retries
 FROM runs r ORDER BY rowid DESC LIMIT 12`;
export const PERFORMANCE_TOOLS = `WITH recent AS (
 SELECT id,data FROM events WHERE json_extract(data,'$.type')='tool.started' ORDER BY id DESC LIMIT 60
 ) SELECT json_extract(s.data,'$.createdAt') AS started_at,
 json_extract(c.data,'$.createdAt') AS finished_at,
 COALESCE(json_extract(s.data,'$.data.actionType'),json_extract(s.data,'$.data.toolName')) AS tool,
 json_extract(c.data,'$.data.result.status') AS status,
 json_extract(c.data,'$.data.result.exitCode') AS exit_code,
 json_extract(c.data,'$.data.result.checkpointStatus') AS checkpoint,
 length(json_extract(c.data,'$.data.result.output')) AS output_characters
 FROM recent s LEFT JOIN events c ON c.source_key='tool:'||json_extract(s.data,'$.data.operationId') ORDER BY s.id DESC`;
export const PERFORMANCE_NATIVE = `SELECT json_extract(t.record,'$.kind') AS kind,t.status,
 (SELECT json_extract(c.value,'$.name') FROM pi_entries e,json_each(e.record,'$.model[0].content') c
 WHERE e.id=json_extract(t.record,'$.input.assistant') AND json_extract(c.value,'$.id')=json_extract(t.record,'$.input.callId')) AS tool,
 json_extract(t.record,'$.state.checkpoint.replay') AS replay,
 json_extract(t.record,'$.conversationId')=1 AS is_root,
 json_extract(t.record,'$.state.checkpoint.phase') AS phase,json_extract(t.record,'$.state.checkpoint.attempt') AS attempt,
 json_extract(t.record,'$.state.outcome.status') AS outcome,json_extract(t.record,'$.background') AS background
 FROM pi_tasks t ORDER BY (t.status!='terminal') DESC,t.id DESC LIMIT 60`;
export const PERFORMANCE_DELIVERIES = `SELECT t.status AS delivery_status,
 json_extract(t.record,'$.state.checkpoint.phase') AS phase,s.status AS submission_status,
 s.conversation_id=1 AS is_root,
 EXISTS(SELECT 1 FROM pi_tasks w JOIN pi_entries e ON e.id=json_extract(w.record,'$.input.assistant'),json_each(e.record,'$.model[0].content') c
 WHERE w.conversation_id=s.conversation_id AND w.status='running' AND json_extract(c.value,'$.id')=json_extract(w.record,'$.input.callId') AND json_extract(c.value,'$.name')='wait_subagent') AS recipient_waiting
 FROM pi_tasks t LEFT JOIN pi_submissions s ON s.request_id=json_quote(json_extract(t.record,'$.input.operationId'))
 WHERE json_extract(t.record,'$.kind')='timber.subagent-delivery' AND t.status!='terminal' ORDER BY t.id DESC LIMIT 20`;
export const PERFORMANCE_WAKES = `SELECT capability,fn,time,running,execution_started_at,recovery_loop FROM cf_agents_jobs ORDER BY time LIMIT 40`;
export const PERFORMANCE_RECOVERY = `SELECT 
 (SELECT COUNT(*) FROM pi_documents WHERE kind='timber.subagent-waits') AS wait_graphs,
 (SELECT COUNT(*) FROM pi_tasks WHERE status!='terminal') AS active_native_tasks,
 (SELECT COUNT(*) FROM pi_submissions WHERE status='queued') AS queued_inputs`;
export const PERFORMANCE_PROCESSES = `SELECT status,dispatch_state,cancel_requested,
 json_extract(result,'$.status') AS result_status,json_extract(result,'$.exitCode') AS exit_code
 FROM run_processes ORDER BY rowid DESC LIMIT 40`;
export const PERFORMANCE_USAGE = `SELECT json_extract(record,'$.model[0].timestamp') AS timestamp,
 json_extract(record,'$.model[0].usage.input') AS input_tokens,
 json_extract(record,'$.model[0].usage.output') AS output_tokens,
 json_extract(record,'$.model[0].usage.cacheRead') AS cached_tokens,
 json_extract(record,'$.model[0].stopReason') AS stop_reason
 FROM pi_entries WHERE json_extract(record,'$.kind')='pi.assistant' ORDER BY id DESC LIMIT 40`;

const states=new Set(['pending','queued','running','waiting','waiting_approval','waiting_connection','completed','failed','interrupted','cancelling','cancelled','completing','terminal','aborted','faulted','orphaned']);
const tools=new Set(['exec','exec_poll','exec_cancel','call_tool','spawn_subagent','send_subagent_message','wait_subagent','list_subagents','cancel_subagent','execPoll','execCancel','readFile','writeFile','listFiles','checkpoint','gitClone','gitPush','screenshot','navigate','click','type','key','scroll','list_tools','load_skill','github_clone','github_push','github_create_pull_request','github_list_pull_requests','github_list_repositories','publish_app','list_apps','create_task','list_tasks','update_task','request_secret','configure_secret','name_secret','list_secrets','secret_request']);
const kinds=new Set(['pi.generation','pi.compaction','pi.tool','timber.memory-review','timber.subagent-delivery']);
const phases=new Set(['prepare','request','retry','poll','tools','yield','wait','apply','deliver','report','execute','invoke']);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;
const allow=(set,value)=>set.has(value)?value:'unknown';
export function summarizePerformance({runs=[],tools:actions=[],native=[],usage=[],processes=[],deliveries=[],wakes=[],recovery=[]},window) {
 const inside=value=>{const at=Date.parse(value??'');return Number.isFinite(at)&&at>=window.from&&at<=window.to;};
 return {
  runs:runs.slice(0,12).filter(row=>inside(iso(row.updated_at))||inside(iso(row.created_at))).map(row=>({createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),status:allow(states,row.status),generations:count(row.generations),tools:count(row.tools),retries:count(row.retries)})),
  tools:actions.slice(0,60).filter(row=>inside(iso(row.finished_at))||inside(iso(row.started_at))).map(row=>{const startedAt=iso(row.started_at),finishedAt=iso(row.finished_at);return {startedAt,finishedAt,tool:allow(tools,row.tool),status:allow(states,row.status),durationMs:startedAt&&finishedAt?count(Date.parse(finishedAt)-Date.parse(startedAt)):null,exitCode:Number.isSafeInteger(row.exit_code)?row.exit_code:null,checkpoint:allow(new Set(['pending','saved','failed']),row.checkpoint),outputCharacters:count(row.output_characters)};}),
  nativeTasks:native.slice(0,60).map(row=>({kind:allow(kinds,row.kind),status:allow(states,row.status),phase:allow(phases,row.phase),tool:allow(tools,row.tool),replay:allow(new Set(['safe','unsafe']),row.replay),isRoot:row.is_root===1,attempt:count(row.attempt),outcome:allow(states,row.outcome),background:row.background===1})),
  recovery:recovery.slice(0,1).map(row=>({waitGraphs:count(row.wait_graphs),activeNativeTasks:count(row.active_native_tasks),queuedInputs:count(row.queued_inputs)})),
  wakes:wakes.slice(0,40).map(row=>({capability:allow(new Set(['pi-harness','botspace-subagents','botspace-admission']),row.capability),fn:allow(new Set(['wake','retry']),row.fn),at:count(row.time)===null?null:new Date(row.time).toISOString(),running:row.running===1,executionStartedAt:count(row.execution_started_at)===null?null:new Date(row.execution_started_at).toISOString(),recoveryLoop:row.recovery_loop===1})),
  deliveries:deliveries.slice(0,20).map(row=>({status:allow(states,row.delivery_status),phase:allow(phases,row.phase),submissionStatus:allow(new Set(['queued','placed','done','unanswered']),row.submission_status),recipientWaiting:row.recipient_waiting===1})),
  processes:processes.slice(0,40).map(row=>({status:allow(states,row.status),dispatchState:allow(new Set(['registered','dispatching','uncertain','acknowledged']),row.dispatch_state),resultStatus:allow(states,row.result_status),exitCode:Number.isSafeInteger(row.exit_code)?row.exit_code:null,cancelRequested:row.cancel_requested===1})),
  modelResponses:usage.slice(0,40).filter(row=>count(row.timestamp)!==null&&row.timestamp>=window.from&&row.timestamp<=window.to).map(row=>({at:new Date(row.timestamp).toISOString(),inputTokens:count(row.input_tokens),outputTokens:count(row.output_tokens),cachedTokens:count(row.cached_tokens),stopReason:allow(new Set(['stop','length','toolUse','error','aborted']),row.stop_reason)})),
 };
}
export function performanceTaskMetadata(row){return {createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),status:allow(states,row.status)};}
