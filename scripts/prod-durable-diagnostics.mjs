#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {createCipheriv,createHash,createPublicKey,publicEncrypt,randomBytes,constants} from 'node:crypto';
import { DIAGNOSTIC_CODES, timeframe } from './prod-diagnostics.mjs';

// Cloudflare Data Studio's SQL API. These are fixed read-only statements;
// neither SQL nor object names can be supplied by workflow dispatch inputs.
// https://github.com/cloudflare/cf/blob/7d7a6d9f6c32ff7d5d72fe56fe2d84fa78e7355f/packages/cli/src/sdk/sdk/api/resources/durableObjects/resources/namespaces/client/Client.ts#L112
export const BOT_LOOKUP = "SELECT id FROM bots WHERE lower(json_extract(data,'$.name'))='polibot' LIMIT 2";
export const SCHEMA = "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('pi_submissions','pi_tasks','runs','submissions','botspace_runtime_generations') ORDER BY name";
export const FAILURE_QUERY = `WITH recent AS (
 SELECT id,json_extract(record,'$.requestId') AS request_id,record FROM pi_submissions
 WHERE status='unanswered' AND json_extract(record,'$.type')='input'
 ORDER BY id DESC LIMIT 24
), detail AS (
 SELECT *,json_extract(record,'$.reason') AS native_reason,
 json_type(record,'$.detail') AS detail_type,
 CASE WHEN json_type(record,'$.detail')='text' THEN json_extract(record,'$.detail') ELSE '' END AS d FROM recent
)
SELECT json_extract(r.data,'$.createdAt') AS run_created_at,
 json_extract(r.data,'$.updatedAt') AS run_updated_at,
 json_extract(r.data,'$.status') AS run_status,
 json_extract(r.data,'$.errorCode') AS error_code,
 CASE WHEN d.native_reason IN ('model_error','faulted','aborted','no_model','reset','stale','tool_error','task_error','task_failed','budget_exceeded') THEN d.native_reason ELSE 'other' END AS native_reason,
 d.detail_type,length(d.d) AS detail_characters,
 CASE
 WHEN d.detail_type IS NULL THEN 'no_detail'
 WHEN d.detail_type<>'text' THEN 'non_string_detail'
 WHEN d.d='model_request_failed: The model request failed before an answer completed. Your conversation and recorded tool results are preserved.' THEN 'sanitized_model_request_failed'
 WHEN instr(d.d,'model_request_failed')>0 THEN 'contains_fixed_model_request_failed'
 WHEN instr(d.d,'Value contains a non-JSON undefined')>0 THEN 'native_json_undefined'
 WHEN instr(d.d,'is not visible from conversation')>0 THEN 'native_entry_visibility'
 WHEN instr(d.d,'OpenAI Responses stream completed with an unfinished tool call')>0 THEN 'sdk_unfinished_tool_call'
 WHEN instr(d.d,'Unhandled stop reason')>0 THEN 'sdk_unhandled_stop_reason'
 WHEN instr(d.d,'Unexpected token')>0 OR instr(d.d,'Unexpected end of JSON')>0 OR instr(d.d,'is not valid JSON')>0 OR instr(d.d,'JSON.parse')>0 THEN 'json_parse'
 WHEN instr(d.d,'Model request has no durable originating operation')>0 THEN 'missing_origin_operation'
 WHEN instr(d.d,'Model request has no durable conversation identity')>0 THEN 'missing_conversation_identity'
 WHEN instr(d.d,'SQLITE_')>0 OR instr(lower(d.d),'string or blob too big')>0 THEN 'sqlite_error'
 WHEN instr(d.d,'Cannot read properties of')>0 OR instr(d.d,'is not a function')>0 THEN 'javascript_type_error'
 WHEN instr(d.d,'chatgpt_connection_changed')>0 THEN 'chatgpt_connection_changed'
 WHEN instr(d.d,'chatgpt_invalid_tool_namespace')>0 THEN 'chatgpt_invalid_tool_namespace'
 WHEN instr(d.d,'chatgpt_incomplete_response')>0 THEN 'chatgpt_incomplete_response'
 WHEN instr(d.d,'chatgpt_output_limit')>0 THEN 'chatgpt_output_limit'
 ELSE 'unclassified' END AS detail_signature
FROM detail d LEFT JOIN submissions s ON s.operation_id=d.request_id LEFT JOIN runs r ON r.id=s.run_id ORDER BY d.id DESC`;

// Reuse the same fixed signature CASE for failed native tasks. Raw detail never
// leaves SQLite, including when the task contains a private provider response.
const signatureSql=FAILURE_QUERY.slice(FAILURE_QUERY.indexOf(' CASE\n WHEN d.detail_type'),FAILURE_QUERY.indexOf('\nFROM detail'));
export const TASK_QUERY=`WITH recent AS (
 SELECT id,json_extract(record,'$.kind') AS kind,status,record FROM pi_tasks WHERE status='terminal' AND json_extract(record,'$.state.outcome.status') IN ('failed','faulted','orphaned') ORDER BY id DESC LIMIT 24
), detail AS (
 SELECT *,json_extract(record,'$.state.outcome.status') AS outcome,
 json_type(record,'$.state.outcome.error.message') AS detail_type,
 CASE WHEN json_type(record,'$.state.outcome.error.message')='text' THEN json_extract(record,'$.state.outcome.error.message') ELSE '' END AS d,
 json_extract(record,'$.state.outcome.error.detail.reason') AS native_reason FROM recent
)
SELECT CASE WHEN d.kind IN ('pi.generation','pi.compaction','pi.tool') THEN d.kind ELSE 'other' END AS task_kind,
 d.outcome,json_extract(r.data,'$.createdAt') AS run_created_at,json_extract(r.data,'$.updatedAt') AS run_updated_at,
 CASE WHEN d.native_reason IN ('model_error','faulted','aborted','no_model','reset','stale','tool_error','task_error','task_failed','budget_exceeded') THEN d.native_reason ELSE 'other' END AS native_reason,
 d.detail_type,length(d.d) AS detail_characters,${signatureSql}
FROM detail d LEFT JOIN botspace_runtime_generations g ON g.task_id=CAST(d.id AS TEXT)
LEFT JOIN submissions s ON s.operation_id=g.operation_id LEFT JOIN runs r ON r.id=s.run_id ORDER BY d.id DESC`;

// Optional private diagnostic: exactly three bounded native error details, with
// no prompts, conversation entries, identifiers, tool results or auth storage.
// This response is encrypted in memory for the caller before any console output.
export const PRIVATE_FAILURE_QUERY=`WITH recent AS (
 SELECT id,record FROM pi_submissions WHERE status='unanswered' AND json_extract(record,'$.type')='input' ORDER BY id DESC LIMIT 3
)
SELECT json_extract(r.data,'$.createdAt') AS run_created_at,json_extract(r.data,'$.updatedAt') AS run_updated_at,
 json_extract(p.record,'$.reason') AS native_reason,
 json_type(p.record,'$.detail') AS detail_type,
 CASE WHEN json_type(p.record,'$.detail')='text' THEN substr(json_extract(p.record,'$.detail'),1,8192) ELSE NULL END AS detail
FROM recent p LEFT JOIN submissions s ON s.operation_id=json_extract(p.record,'$.requestId') LEFT JOIN runs r ON r.id=s.run_id ORDER BY p.id DESC`;
const ENCRYPTION_CONTEXT='timber-api/native-failure-diagnostics/v1';

const SCHEMA_NAMES = new Set(['pi_submissions','pi_tasks','runs','submissions','botspace_runtime_generations']);
const SIGNATURES = new Set(['no_detail','non_string_detail','sanitized_model_request_failed','contains_fixed_model_request_failed','native_json_undefined','native_entry_visibility','sdk_unfinished_tool_call','sdk_unhandled_stop_reason','json_parse','missing_origin_operation','missing_conversation_identity','sqlite_error','javascript_type_error','chatgpt_connection_changed','chatgpt_invalid_tool_namespace','chatgpt_incomplete_response','chatgpt_output_limit','unclassified']);
const REASONS = new Set(['model_error','faulted','aborted','no_model','reset','stale','tool_error','task_error','task_failed','budget_exceeded','other']);
const STATUSES = new Set(['queued','running','waiting_approval','waiting_connection','completed','failed','interrupted','cancelled']);
const TYPES = new Set(['text','integer','real','object','array','true','false','null']);
const ERRORS = new Set(['durable_diagnostics_account_missing','durable_diagnostics_auth_missing','durable_diagnostics_transport_failed','durable_diagnostics_response_limit','durable_diagnostics_invalid_response','durable_diagnostics_query_failed','durable_diagnostics_namespace_missing','durable_diagnostics_bot_not_unique','durable_diagnostics_schema_mismatch','durable_diagnostics_invalid_recipient','durable_diagnostics_encryption_failed']);
const MAX_BYTES = 256 * 1024;
const uuid = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const iso = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function rows(payload) {
  const result=payload?.result;
  if(payload?.success!==true || result?.error || !Array.isArray(result?.results) || result.results.length!==1) throw new Error('durable_diagnostics_query_failed');
  const entry=result.results[0];
  if(!Array.isArray(entry?.columns)||!entry.columns.every(name=>typeof name==='string')||!Array.isArray(entry.rows)||entry.rows.length>100||entry.meta?.rows_written!==0) throw new Error('durable_diagnostics_invalid_response');
  return entry.rows.map(row=>{
    if(!Array.isArray(row)||row.length!==entry.columns.length)throw new Error('durable_diagnostics_invalid_response');
    return Object.fromEntries(entry.columns.map((name,index)=>[name,row[index]]));
  });
}

export function summarizeFailures(records,window) {
  const failures=[]; let outsideWindow=0;
  for(const row of records.slice(0,24)) {
    const updatedAt=iso(row.run_updated_at),createdAt=iso(row.run_created_at);
    const at=Date.parse(updatedAt??createdAt??'');
    if(!Number.isFinite(at)||at<window.from||at>window.to) {outsideWindow++;continue;}
    failures.push({createdAt,updatedAt,status:STATUSES.has(row.run_status)?row.run_status:'unknown',
      errorCode:DIAGNOSTIC_CODES.has(row.error_code)?row.error_code:'unknown',
      nativeReason:REASONS.has(row.native_reason)?row.native_reason:'other',
      detailType:TYPES.has(row.detail_type)?row.detail_type:row.detail_type===null?'absent':'unknown',
      detailCharacters:Number.isSafeInteger(row.detail_characters)&&row.detail_characters>=0&&row.detail_characters<=100_000_000?row.detail_characters:null,
      signature:SIGNATURES.has(row.detail_signature)?row.detail_signature:'unclassified'});
  }
  return {worker:'timber-api',source:'durable_sql_fixed_select',window:{from:new Date(window.from).toISOString(),to:new Date(window.to).toISOString()},
    inspectedRecentFailures:Math.min(records.length,24),outsideWindow,failures,
    limitation:'Latest 24 native unanswered inputs for the selected bot; only fixed failure signatures and safe metadata are returned. No prompts, raw errors, identifiers, credentials or tool output are emitted.'};
}

export function summarizeTasks(records,window) {
  const tasks=[];
  for(const row of records.slice(0,24)){
    const safe=summarizeFailures([row],window).failures[0];
    if(!safe)continue;
    tasks.push({createdAt:safe.createdAt,updatedAt:safe.updatedAt,
      kind:['pi.generation','pi.compaction','pi.tool'].includes(row.task_kind)?row.task_kind:'other',
      outcome:['failed','faulted','orphaned'].includes(row.outcome)?row.outcome:'other',
      nativeReason:safe.nativeReason,detailType:safe.detailType,detailCharacters:safe.detailCharacters,signature:safe.signature});
  }
  return {inspectedRecentTasks:Math.min(records.length,24),outsideWindowOrUnattributed:Math.min(records.length,24)-tasks.length,tasks};
}

export function recipientPublicKey(pem) {
  if(typeof pem!=='string'||pem.length>8192||!/^-{5}BEGIN PUBLIC KEY-{5}\r?\n/.test(pem)||pem.includes('PRIVATE KEY'))throw new Error('durable_diagnostics_invalid_recipient');
  try{
    const key=createPublicKey(pem);
    if(key.asymmetricKeyType!=='rsa'||!Number.isInteger(key.asymmetricKeyDetails?.modulusLength)||key.asymmetricKeyDetails.modulusLength<3072||key.asymmetricKeyDetails.modulusLength>8192)throw new Error();
    return key;
  }catch{throw new Error('durable_diagnostics_invalid_recipient');}
}

export function encryptDetails(records,recipient,window) {
  // Reconstruct the payload explicitly; unexpected response columns never enter
  // even the encrypted diagnostic. All raw provider detail remains in memory.
  const failures=records.slice(0,3).map(row=>({createdAt:iso(row.run_created_at),updatedAt:iso(row.run_updated_at),
    nativeReason:REASONS.has(row.native_reason)?row.native_reason:'other',
    detailType:TYPES.has(row.detail_type)?row.detail_type:row.detail_type===null?'absent':'unknown',
    detail:typeof row.detail==='string'?row.detail.slice(0,8192):null}));
  const key=randomBytes(32),iv=randomBytes(12);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT));
    const plaintext=Buffer.from(JSON.stringify({context:ENCRYPTION_CONTEXT,requestedWindow:{from:new Date(window.from).toISOString(),to:new Date(window.to).toISOString()},selection:'latest_three_unanswered_inputs',failures}));
    try{
      const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      const wrapped=publicEncrypt({key:recipient,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from(ENCRYPTION_CONTEXT)},key);
      return {version:1,algorithm:'RSA-OAEP-SHA256+A256GCM',context:ENCRYPTION_CONTEXT,
        recipientKeySha256:createHash('sha256').update(recipient.export({format:'der',type:'spki'})).digest('hex'),
        encryptedKey:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
    }finally{plaintext.fill(0);}
  }catch{throw new Error('durable_diagnostics_encryption_failed');}
  finally{key.fill(0);}
}

async function readJson(response) {
  if(!response.body)throw new Error('durable_diagnostics_invalid_response');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new Error('durable_diagnostics_response_limit');}chunks.push(value);}}
  finally {reader.releaseLock();}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('durable_diagnostics_invalid_response');}
}

export async function collectDurable({env=process.env,fetcher=fetch,now=Date.now()}={}) {
  const recipient=env.DIAGNOSTIC_RECIPIENT_PUBLIC_KEY?recipientPublicKey(env.DIAGNOSTIC_RECIPIENT_PUBLIC_KEY):undefined;
  const account=env.CLOUDFLARE_ACCOUNT_ID;
  if(typeof account!=='string'||!/^[a-f0-9]{24,64}$/i.test(account))throw new Error('durable_diagnostics_account_missing');
  const headers={'content-type':'application/json'};
  if(env.CLOUDFLARE_API_TOKEN)headers.Authorization=`Bearer ${env.CLOUDFLARE_API_TOKEN}`;
  else if(env.CLOUDFLARE_API_KEY&&env.CLOUDFLARE_EMAIL){headers['X-Auth-Key']=env.CLOUDFLARE_API_KEY;headers['X-Auth-Email']=env.CLOUDFLARE_EMAIL;}
  else throw new Error('durable_diagnostics_auth_missing');
  const window=timeframe({hours:env.DIAGNOSTIC_HOURS??1},now);
  const base=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces`;
  async function request(url,body){
    let response;
    try {response=await fetcher(url,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(30_000)});}
    catch{throw new Error('durable_diagnostics_transport_failed');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error(`durable_diagnostics_http_${response.status}`);}
    return readJson(response);
  }
  const list=await request(`${base}?per_page=1000`);
  if(list?.success!==true||!Array.isArray(list.result)||list.result.length>=1000)throw new Error('durable_diagnostics_invalid_response');
  function namespace(name){
    const matches=list.result.filter(item=>item?.script==='timber-api'&&item.class===name&&item.use_sqlite===true&&/^[a-f0-9]{32}$/i.test(item.id));
    if(matches.length!==1)throw new Error('durable_diagnostics_namespace_missing');
    return matches[0].id;
  }
  async function query(namespaceId,name,sql){return rows(await request(`${base}/${namespaceId}/query/v2`,{durable_object_name:name,jurisdiction:'none',queries:[{sql}]}));}
  const workspace=namespace('WorkspaceDO'),bot=namespace('BotDO');
  const selected=await query(workspace,'owner',BOT_LOOKUP);
  if(selected.length!==1||!uuid(selected[0]?.id))throw new Error('durable_diagnostics_bot_not_unique');
  const name=`owner:${selected[0].id}`;
  const schema=await query(bot,name,SCHEMA);
  if(schema.length!==SCHEMA_NAMES.size||!schema.every(row=>SCHEMA_NAMES.has(row.name)))throw new Error('durable_diagnostics_schema_mismatch');
  const summary=summarizeFailures(await query(bot,name,FAILURE_QUERY),window);
  const nativeTasks=summarizeTasks(await query(bot,name,TASK_QUERY),window);
  const encryptedDiagnostic=recipient?encryptDetails(await query(bot,name,PRIVATE_FAILURE_QUERY),recipient,window):undefined;
  return {...summary,nativeTasks,...(encryptedDiagnostic?{encryptedDiagnostic}:{})};
}

export function safeError(error) {
  return ERRORS.has(error?.message)||/^durable_diagnostics_http_[1-5]\d{2}$/.test(error?.message??'')?error.message:'durable_diagnostics_failed';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await collectDurable(),null,2));}
  catch(error){console.error(JSON.stringify({error:safeError(error)}));process.exitCode=1;}
}
