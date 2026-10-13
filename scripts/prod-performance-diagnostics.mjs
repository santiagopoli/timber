// Fixed read-only projections. Never select prompts, arguments, tool output or
// credentials; identifiers used for routing stay inside collectDurable.
export const PERFORMANCE_SCHEMA = "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('runs','submissions','events','botspace_runtime_budget','pi_tasks','pi_entries','timber_inference_requests','admission_sources','cf_agents_jobs','pi_documents','pi_document_revisions','pi_submissions','run_processes','task_environment','pending_run_cancellations') ORDER BY name";
export const PERFORMANCE_TASKS = `SELECT t.id,b.id AS bot_id,json_extract(t.data,'$.status') AS status,COALESCE(json_extract(t.data,'$.computerMode'),'shared') AS computer_mode,
 json_extract(t.data,'$.createdAt') AS created_at,json_extract(t.data,'$.updatedAt') AS updated_at,
 CASE WHEN s.task_id IS NULL THEN 'none' WHEN s.task_id=t.id THEN 'self' WHEN s.task_id='@bot' THEN 'bot' WHEN s.task_id LIKE '@direct:%' THEN 'direct' ELSE 'other_task' END AS holder,
 s.updated_at AS slot_updated_at,
 (SELECT COUNT(*) FROM computer_admissions a WHERE a.bot_id=CASE WHEN json_extract(t.data,'$.computerMode')='isolated' THEN 'task:'||t.id ELSE b.id END) AS admissions,
 (SELECT COUNT(*) FROM computer_admissions a WHERE a.bot_id=CASE WHEN json_extract(t.data,'$.computerMode')='isolated' THEN 'task:'||t.id ELSE b.id END AND a.payload IS NOT NULL) AS pinned_effects
 FROM tasks t JOIN bots b ON b.id=json_extract(t.data,'$.botId') LEFT JOIN task_slots s ON s.bot_id=CASE WHEN json_extract(t.data,'$.computerMode')='isolated' THEN 'task:'||t.id ELSE b.id END
 ORDER BY (json_extract(t.data,'$.status') IN ('queued','running','waiting_approval','waiting_connection','cancelling')) DESC,t.rowid DESC LIMIT 6`;
export const PERFORMANCE_REQUESTS = `SELECT source,phase,started_at,last_progress_at,bytes,http_status,idle,estimated_tokens FROM timber_inference_requests ORDER BY id DESC LIMIT 20`;
export function summarizeInferenceRequests(records){return records.slice(0,20).map(row=>({source:allow(new Set(['chatgpt','openai-api','openrouter']),row.source),phase:allow(new Set(['request','streaming','completed','failed','cancelled']),row.phase),startedAt:count(row.started_at)===null?null:new Date(row.started_at).toISOString(),lastProgressAt:count(row.last_progress_at)===null?null:new Date(row.last_progress_at).toISOString(),bytes:count(row.bytes),httpStatus:count(row.http_status),idleTimeout:row.idle===1,estimatedTokens:count(row.estimated_tokens)}));}
export const PERFORMANCE_RUNS = `WITH recent AS (
 SELECT id,data,rowid AS sequence FROM runs
 ORDER BY (json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection')) DESC,rowid DESC LIMIT 12
 ) SELECT json_extract(data,'$.createdAt') AS created_at,
 json_extract(data,'$.updatedAt') AS updated_at,json_extract(data,'$.status') AS status,
 json_extract(data,'$.errorCode') AS error_code,
 (SELECT kind FROM admission_sources a WHERE a.run_id=r.id) AS source,
 (SELECT COUNT(*) FROM botspace_runtime_budget b JOIN submissions s ON s.operation_id=b.operation_id WHERE s.run_id=r.id AND b.kind='generation') AS generations,
 (SELECT COUNT(*) FROM botspace_runtime_budget b JOIN submissions s ON s.operation_id=b.operation_id WHERE s.run_id=r.id AND b.kind='tool') AS tools,
 (SELECT COUNT(*) FROM events e WHERE json_extract(e.data,'$.runId')=r.id AND json_extract(e.data,'$.type')='run.retrying') AS retries
 FROM recent r ORDER BY (json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection')) DESC,sequence DESC`;
export const PERFORMANCE_TOOLS = `WITH recent AS (
 SELECT id,data FROM events WHERE json_extract(data,'$.type')='tool.started' ORDER BY id DESC LIMIT 60
 ) SELECT json_extract(s.data,'$.createdAt') AS started_at,
 json_extract(c.data,'$.createdAt') AS finished_at,
 COALESCE(json_extract(s.data,'$.data.actionType'),json_extract(s.data,'$.data.toolName')) AS tool,
 json_extract(c.data,'$.data.result.status') AS status,
 json_extract(c.data,'$.data.result.exitCode') AS exit_code,
 json_extract(c.data,'$.data.result.checkpointStatus') AS checkpoint,
 length(json_extract(c.data,'$.data.result.output')) AS output_characters,
 json_extract(s.data,'$.data.input.timeoutMs') AS deadline_ms,
 json_extract(s.data,'$.data.input.yieldMs') AS yield_ms,
 length(json_extract(s.data,'$.data.input.content')) AS written_characters,
 CASE WHEN json_extract(s.data,'$.data.actionType') IN ('readFile','writeFile') THEN
 CASE WHEN json_extract(s.data,'$.data.input.path') LIKE '%.sh' THEN 'shell'
 WHEN json_extract(s.data,'$.data.input.path') LIKE '%.py' THEN 'python'
 WHEN json_extract(s.data,'$.data.input.path') LIKE '%.ts' OR json_extract(s.data,'$.data.input.path') LIKE '%.tsx' THEN 'typescript'
 WHEN json_extract(s.data,'$.data.input.path') LIKE '%.js' OR json_extract(s.data,'$.data.input.path') LIKE '%.mjs' THEN 'javascript'
 WHEN json_extract(s.data,'$.data.input.path') LIKE '%.log' OR json_extract(s.data,'$.data.input.path') LIKE '%.out' THEN 'log'
 ELSE 'other' END ELSE NULL END AS file_kind,
 CASE WHEN lower(json_extract(s.data,'$.data.input.key')) IN ('return','enter','ctrl+c','ctrl+d','ctrl+v','ctrl+l','alt+f2','ctrl+alt+t') THEN lower(json_extract(s.data,'$.data.input.key')) ELSE NULL END AS key_kind,
 CASE WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'timed out')>0 THEN 'timeout'
 WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'session is unavailable')>0 THEN 'session_unavailable'
 WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'restarted')>0 THEN 'computer_restarted'
 WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'checkpoint')>0 THEN 'checkpoint'
 WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'person has control')>0 THEN 'human_control'
 WHEN instr(lower(json_extract(c.data,'$.data.result.error')),'connection')>0 THEN 'connection'
 WHEN instr(lower(json_extract(c.data,'$.data.result.output')),'command not found')>0 THEN 'command_not_found'
 WHEN json_extract(c.data,'$.data.result.error') IS NOT NULL THEN 'other' ELSE NULL END AS failure_kind
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
 (SELECT COUNT(*) FROM pi_tasks a WHERE a.conversation_id=s.conversation_id AND a.status!='terminal') AS recipient_active_tasks,
 EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_environment') AS isolated_task_runtime_loaded,
 (SELECT COUNT(*) FROM pi_entries WHERE json_extract(record,'$.kind')='timber.queue-wake') AS queue_wake_markers,
 (SELECT CASE WHEN r.kind='base' THEN json_extract(r.content,'$.run.taskId') IS NOT NULL END
 FROM pi_documents d JOIN pi_document_revisions r ON r.document_id=d.id
 WHERE d.kind=json_quote('pi.live') AND d.scope_kind='conversation' AND d.owner_id=s.conversation_id AND d.retired_at IS NULL ORDER BY r.seq DESC LIMIT 1) AS recipient_live_run,
 (SELECT a.status FROM pi_tasks a WHERE a.id=(SELECT CASE WHEN r.kind='base' THEN json_extract(r.content,'$.run.taskId') END
 FROM pi_documents d JOIN pi_document_revisions r ON r.document_id=d.id
 WHERE d.kind=json_quote('pi.live') AND d.scope_kind='conversation' AND d.owner_id=s.conversation_id AND d.retired_at IS NULL ORDER BY r.seq DESC LIMIT 1)) AS recipient_controller_status,
 (SELECT CASE WHEN r.kind='base' THEN EXISTS(SELECT 1 FROM json_each(r.content,'$.items') item WHERE json_extract(item.value,'$.id')=s.id) END
 FROM pi_documents d JOIN pi_document_revisions r ON r.document_id=d.id
 WHERE d.kind=json_quote('pi.inbox') AND d.scope_kind='conversation' AND d.owner_id=s.conversation_id AND d.retired_at IS NULL ORDER BY r.seq DESC LIMIT 1) AS recipient_inbox_matches,

 EXISTS(SELECT 1 FROM pi_tasks w JOIN pi_entries e ON e.id=json_extract(w.record,'$.input.assistant'),json_each(e.record,'$.model[0].content') c
 WHERE w.conversation_id=s.conversation_id AND w.status='running' AND json_extract(c.value,'$.id')=json_extract(w.record,'$.input.callId') AND json_extract(c.value,'$.name')='wait_subagent') AS recipient_waiting
 FROM pi_tasks t LEFT JOIN pi_submissions s ON s.request_id=json_quote(json_extract(t.record,'$.input.operationId'))
 WHERE json_extract(t.record,'$.kind')='timber.subagent-delivery' AND t.status!='terminal' ORDER BY t.id DESC LIMIT 20`;
export const PERFORMANCE_WAKES = `SELECT capability,fn,time,running,execution_started_at,recovery_loop FROM cf_agents_jobs ORDER BY time LIMIT 40`;
export const PERFORMANCE_RECOVERY = `SELECT 
 (SELECT COUNT(*) FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection') AND COALESCE(json_extract(data,'$.coordinatorMode'),0)=0) AS unresolved_host_receipts,
 (SELECT COUNT(*) FROM runs WHERE json_extract(data,'$.status')='waiting_approval') AS approval_waits,
 (SELECT COUNT(*) FROM runs WHERE json_extract(data,'$.status')='waiting_connection') AS connection_waits,
 (SELECT COUNT(*) FROM pi_documents WHERE kind=json_quote('timber.subagent-waits')) AS wait_graphs,
 (SELECT COUNT(*) FROM pi_tasks WHERE status!='terminal') AS active_native_tasks,
 (SELECT COUNT(*) FROM pi_submissions WHERE status='queued') AS queued_inputs`;
export const PERFORMANCE_PROCESSES = `SELECT status,dispatch_state,cancel_requested,
 json_extract(result,'$.status') AS result_status,json_extract(result,'$.exitCode') AS exit_code
 FROM run_processes ORDER BY (status='running') DESC,rowid DESC LIMIT 40`;
export const PERFORMANCE_HOST_WAITS = `SELECT (SELECT COUNT(*) FROM run_processes WHERE status='running') AS active_processes,(SELECT COUNT(*) FROM pending_run_cancellations) AS pending_cancellations`;
export const PERFORMANCE_USAGE = `SELECT json_extract(record,'$.model[0].timestamp') AS timestamp,
 json_extract(record,'$.model[0].usage.input') AS input_tokens,
 json_extract(record,'$.model[0].usage.output') AS output_tokens,
 json_extract(record,'$.model[0].usage.cacheRead') AS cached_tokens,
 json_extract(record,'$.model[0].stopReason') AS stop_reason
 FROM pi_entries WHERE json_extract(record,'$.kind')='pi.assistant' ORDER BY id DESC LIMIT 40`;

// Count real computer effects, rather than their duplicate native tool wrapper.
// Arguments remain inside SQLite, including when grouping identical requests.
export const PERFORMANCE_ACTIVITY = `WITH effects AS (
 SELECT source_key,data,substr(json_extract(data,'$.createdAt'),1,13)||':00:00.000Z' AS hour,
 json_extract(data,'$.data.actionType') AS tool FROM events
 WHERE json_extract(data,'$.type')='tool.started' AND json_extract(data,'$.data.actionType') IS NOT NULL
), grouped AS (
 SELECT s.hour,s.tool,COUNT(*) AS actions,
 SUM(json_extract(c.data,'$.data.result.status')='failed') AS failed,
 SUM(json_extract(c.data,'$.data.result.status')='interrupted') AS interrupted,
 SUM(COALESCE(instr(lower(json_extract(c.data,'$.data.result.error')),'timed out')>0,0)) AS timed_out,
 SUM(CASE WHEN c.data IS NOT NULL THEN MAX(0,CAST((julianday(json_extract(c.data,'$.createdAt'))-julianday(json_extract(s.data,'$.createdAt')))*86400000 AS INTEGER)) ELSE 0 END) AS duration_ms,
 SUM(length(json_extract(s.data,'$.data.input.content'))) AS written_characters
 FROM effects s LEFT JOIN events c ON c.source_key='tool:'||json_extract(s.data,'$.data.operationId')
 GROUP BY s.hour,s.tool
) SELECT * FROM grouped ORDER BY hour DESC,actions DESC LIMIT 90`;

export function summarizeActivity(records,window){return records.slice(0,90).filter(row=>{const at=Date.parse(iso(row.hour)??'');return at>=window.from&&at<=window.to;}).map(row=>({hour:iso(row.hour),tool:allow(tools,row.tool),actions:count(row.actions),failed:count(row.failed),interrupted:count(row.interrupted),timedOut:count(row.timed_out),durationMs:count(row.duration_ms),writtenCharacters:count(row.written_characters)}));}

const states=new Set(['pending','queued','running','waiting','waiting_approval','waiting_connection','completed','failed','interrupted','cancelling','cancelled','completing','terminal','aborted','faulted','orphaned']);
const tools=new Set(['exec','exec_poll','exec_cancel','call_tool','spawn_subagent','send_subagent_message','wait_subagent','list_subagents','cancel_subagent','execPoll','execCancel','readFile','writeFile','listFiles','checkpoint','gitClone','gitPush','screenshot','navigate','click','type','key','scroll','list_tools','load_skill','github_clone','github_push','github_create_pull_request','github_list_pull_requests','github_list_repositories','github_inspect_ci','publish_app','list_apps','create_task','list_tasks','update_task','request_secret','configure_secret','name_secret','list_secrets','secret_request']);
const kinds=new Set(['pi.generation','pi.compaction','pi.tool','timber.memory-review','timber.subagent-delivery']);
const phases=new Set(['prepare','request','retry','poll','tools','yield','wait','apply','deliver','report','execute','invoke']);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;
const allow=(set,value)=>set.has(value)?value:'unknown';
export function summarizePerformance({runs=[],tools:actions=[],native=[],usage=[],processes=[],deliveries=[],wakes=[],recovery=[],hostWaits=[]},window) {
 const inside=value=>{const at=Date.parse(value??'');return Number.isFinite(at)&&at>=window.from&&at<=window.to;};
 return {
  runs:runs.slice(0,12).filter(row=>['queued','running','waiting_approval','waiting_connection'].includes(row.status)||inside(iso(row.updated_at))||inside(iso(row.created_at))).map(row=>({createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),status:allow(states,row.status),source:allow(new Set(['user','internal']),row.source),generations:count(row.generations),tools:count(row.tools),retries:count(row.retries)})),
  tools:actions.slice(0,60).filter(row=>inside(iso(row.finished_at))||inside(iso(row.started_at))).map(row=>{const startedAt=iso(row.started_at),finishedAt=iso(row.finished_at);return {startedAt,finishedAt,tool:allow(tools,row.tool),status:allow(states,row.status),durationMs:startedAt&&finishedAt?count(Date.parse(finishedAt)-Date.parse(startedAt)):null,exitCode:Number.isSafeInteger(row.exit_code)?row.exit_code:null,checkpoint:allow(new Set(['pending','saved','failed']),row.checkpoint),outputCharacters:count(row.output_characters),deadlineMs:count(row.deadline_ms),yieldMs:count(row.yield_ms),writtenCharacters:count(row.written_characters),fileKind:row.file_kind==null?null:allow(new Set(['shell','python','typescript','javascript','log','other']),row.file_kind),keyKind:row.key_kind==null?null:allow(new Set(['return','enter','ctrl+c','ctrl+d','ctrl+v','ctrl+l','alt+f2','ctrl+alt+t']),row.key_kind),failureKind:row.failure_kind==null?null:allow(new Set(['timeout','session_unavailable','computer_restarted','checkpoint','human_control','connection','command_not_found','other']),row.failure_kind)};}),
  nativeTasks:native.slice(0,60).map(row=>({kind:allow(kinds,row.kind),status:allow(states,row.status),phase:allow(phases,row.phase),tool:allow(tools,row.tool),replay:allow(new Set(['safe','unsafe']),row.replay),isRoot:row.is_root===1,attempt:count(row.attempt),outcome:allow(states,row.outcome),background:row.background===1})),
  recovery:recovery.slice(0,1).map(row=>({waitGraphs:count(row.wait_graphs),activeNativeTasks:count(row.active_native_tasks),queuedInputs:count(row.queued_inputs),...('unresolved_host_receipts' in row?{unresolvedHostReceipts:count(row.unresolved_host_receipts),approvalWaits:count(row.approval_waits),connectionWaits:count(row.connection_waits)}:{})})),
  wakes:wakes.slice(0,40).map(row=>({capability:allow(new Set(['pi-harness','botspace-subagents','botspace-admission']),row.capability),fn:allow(new Set(['wake','retry']),row.fn),at:count(row.time)===null?null:new Date(row.time).toISOString(),running:row.running===1,executionStartedAt:count(row.execution_started_at)===null?null:new Date(row.execution_started_at).toISOString(),recoveryLoop:row.recovery_loop===1})),
  deliveries:deliveries.slice(0,20).map(row=>({status:allow(states,row.delivery_status),phase:allow(phases,row.phase),submissionStatus:allow(new Set(['queued','placed','done','unanswered']),row.submission_status),recipientIsRoot:row.is_root===1,recipientActiveTasks:count(row.recipient_active_tasks),isolatedTaskRuntimeLoaded:row.isolated_task_runtime_loaded===1,queueWakeMarkers:count(row.queue_wake_markers),recipientLiveRun:row.recipient_live_run===null||row.recipient_live_run===undefined?null:row.recipient_live_run===1,recipientControllerStatus:allow(states,row.recipient_controller_status),recipientInboxMatches:row.recipient_inbox_matches===null||row.recipient_inbox_matches===undefined?null:row.recipient_inbox_matches===1,recipientWaiting:row.recipient_waiting===1})),
  hostWaits:hostWaits.slice(0,1).map(row=>({activeProcesses:count(row.active_processes),pendingCancellations:count(row.pending_cancellations)})),
  processes:processes.slice(0,40).map(row=>({status:allow(states,row.status),dispatchState:allow(new Set(['registered','dispatching','uncertain','acknowledged']),row.dispatch_state),resultStatus:allow(states,row.result_status),exitCode:Number.isSafeInteger(row.exit_code)?row.exit_code:null,cancelRequested:row.cancel_requested===1})),
  modelResponses:usage.slice(0,40).filter(row=>count(row.timestamp)!==null&&row.timestamp>=window.from&&row.timestamp<=window.to).map(row=>({at:new Date(row.timestamp).toISOString(),inputTokens:count(row.input_tokens),outputTokens:count(row.output_tokens),cachedTokens:count(row.cached_tokens),stopReason:allow(new Set(['stop','length','toolUse','error','aborted']),row.stop_reason)})),
 };
}
export function performanceTaskMetadata(row){return {createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),status:allow(states,row.status),environment:allow(new Set(['shared','isolated']),row.computer_mode),scheduler:{holder:allow(new Set(['none','self','bot','direct','other_task']),row.holder),slotUpdatedAt:count(row.slot_updated_at)===null?null:new Date(row.slot_updated_at).toISOString(),admissions:count(row.admissions),pinnedEffects:count(row.pinned_effects)}};}
