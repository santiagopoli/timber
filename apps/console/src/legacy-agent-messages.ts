import type {Bot, BotEvent, Run, Subagent} from '../../../packages/contracts/src/index';
import {mergeToolStatus} from './cancellation-presentation';

export type LegacyAgentLink = {id:string;name:string;kind:'bot'|'subagent'};
export type LegacyAgentMessageStatus = 'running'|'completed'|'failed'|'interrupted'|'cancelled'|'pending_approval'|'pending_connection'|'unconfirmed';
export type LegacyAgentMessage = {
  key:string;
  /** The source tool's run; callers may resolve its root for the main timeline. */
  runId?:string;
  createdAt:string;
  source:LegacyAgentLink;
  target?:LegacyAgentLink;
  text?:string;
  status:LegacyAgentMessageStatus;
  /** A returned native tool receipt alone does not prove message delivery. */
  delivery:'pending'|'failed'|'unconfirmed';
  operationId?:string;
  toolCallId?:string;
  error?:string;
};
export type LegacyAgentMessagesModel = {
  bot:Pick<Bot,'id'|'name'>;
  events:readonly BotEvent[];
  runs:readonly Run[];
  subagents:readonly Subagent[];
  collaborationEvents?:readonly BotEvent[];
};

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown):string|undefined=>typeof value==='string'?value:undefined;
const identity=(value:unknown):string|undefined=>typeof value==='string'&&value.length>0?value:undefined;
const toolEvents=new Set(['tool.started','tool.completed','subagent.tool.started','subagent.tool.completed']);
const statuses=new Set<LegacyAgentMessageStatus>(['running','completed','failed','interrupted','cancelled','pending_approval','pending_connection','unconfirmed']);
const failureStatuses=new Set(['failed','interrupted','cancelled']);
const pendingStatuses=new Set(['running','pending_approval','pending_connection']);

type ToolGroup = {events:BotEvent[];aliases:Set<string>;lookupKeys:Set<string>;isSend:boolean};

/**
 * Recover historical send tools using explicit IDs and structured public fields.
 * Native historical events often omit both the destination and body. Preserve a
 * neutral, unconfirmed notice in that case; never infer them from transcript text
 * or parse output strings. Dedicated delivery events remain authoritative.
 */
export function collectLegacyAgentMessages(model:LegacyAgentMessagesModel,scopeSubagentId?:string):{items:LegacyAgentMessage[];toolIdentities:Set<string>} {
  const runs=new Map(model.runs.map(run=>[run.id,run]));
  const agents=new Map(model.subagents.map(agent=>[agent.id,agent]));
  const root:LegacyAgentLink={id:model.bot.id,name:model.bot.name,kind:'bot'};
  const child=(id:string):LegacyAgentLink=>({id,name:agents.get(id)?.name||'Subagent',kind:'subagent'});
  const sourceId=(event:BotEvent)=>identity(event.data.subagentId)||identity(event.data.sourceSubagentId)||runs.get(event.runId||'')?.subagentId;
  const events=[...new Map([...model.events,...model.collaborationEvents||[]].map(event=>[`${event.botId}:${event.id}`,event])).values()].sort((left,right)=>left.id-right.id);
  const lookup=new Map<string,ToolGroup>();
  const groups=new Set<ToolGroup>();
  for(const event of events){
    if(!toolEvents.has(event.type))continue;
    const data=event.data,result=record(data.result);
    const operationIds=[identity(data.operationId),identity(result.operationId)].filter((value):value is string=>Boolean(value));
    const callIds=[identity(data.toolCallId),identity(result.toolCallId)].filter((value):value is string=>Boolean(value));
    // Operation IDs are durable identities. Call IDs are scoped to their source
    // conversation/run so two unrelated calls cannot merge by a reused call ID.
    const keys=[...operationIds.map(id=>`operation:${id}`),...callIds.map(id=>`call:${event.runId||''}:${sourceId(event)||''}:${id}`)];
    if(!keys.length)continue;
    const matches=[...new Set(keys.map(key=>lookup.get(key)).filter((value):value is ToolGroup=>Boolean(value)))];
    const group=matches[0]||{events:[],aliases:new Set<string>(),lookupKeys:new Set<string>(),isSend:false};
    for(const merged of matches.slice(1)){
      group.events.push(...merged.events);group.isSend ||= merged.isSend;
      for(const alias of merged.aliases)group.aliases.add(alias);
      for(const key of merged.lookupKeys){group.lookupKeys.add(key);lookup.set(key,group);}
      groups.delete(merged);
    }
    group.events.push(event);
    group.isSend ||= data.toolName==='send_subagent_message'||data.actionType==='send_subagent_message';
    for(const alias of [...operationIds,...callIds])group.aliases.add(alias);
    for(const key of keys){group.lookupKeys.add(key);lookup.set(key,group);}
    groups.add(group);
  }
  const receipts=events.filter(event=>event.type==='subagent.message.sent'||event.type==='subagent.reported');
  const items:LegacyAgentMessage[]=[],toolIdentities=new Set<string>();
  for(const group of groups){
    if(!group.isSend)continue;
    const ordered=group.events.sort((left,right)=>left.id-right.id),first=ordered[0];
    const sourceEvent=ordered.find(event=>sourceId(event))||first;
    const senderId=sourceId(sourceEvent);
    const source=senderId?child(senderId):ordered.some(event=>event.type.startsWith('subagent.'))?child(''):root;
    let targetId:string|undefined,body:string|undefined,status:LegacyAgentMessageStatus|undefined,error:string|undefined;
    let operationId:string|undefined,toolCallId:string|undefined,returned=false;
    for(const event of ordered){
      const data=event.data,result=record(data.result);
      operationId=identity(data.operationId)||identity(result.operationId)||operationId;
      toolCallId=identity(data.toolCallId)||identity(result.toolCallId)||toolCallId;
      // These are explicit metadata containers, never arbitrary tool output.
      for(const metadata of [result,data,record(data.action),record(data.arguments),record(data.input)]){
        targetId=identity(metadata.targetId)||targetId;
        const message=text(metadata.text);if(message!==undefined)body=message;
      }
      const completed=event.type.endsWith('tool.completed');
      const observed=text(result.status)||text(data.status);
      const incoming:LegacyAgentMessageStatus|undefined=data.isError===true||result.isError===true?'failed'
        : observed&&statuses.has(observed as LegacyAgentMessageStatus)?observed as LegacyAgentMessageStatus
        : completed?(status==='pending_approval'||status==='pending_connection'?status:'completed'):undefined;
      const merged=mergeToolStatus(status,incoming) as LegacyAgentMessageStatus|undefined;
      // A later native cancellation/error is not a new outcome for a send that
      // already returned successfully. Keep its original status and detail.
      if(!incoming||merged===incoming)error=text(result.error)||text(record(result.error).message)||text(data.error)||text(record(data.error).message)||error;
      status=merged;
      returned ||= completed;
    }
    const sender=senderId?agents.get(senderId):undefined;
    // A child's latest submission records the send's exact operation ID. Use
    // that durable join only when it identifies one recipient unambiguously.
    const matchingTargets=!targetId&&operationId?model.subagents.filter(agent=>agent.operationId===operationId):[];
    const target=targetId==='parent'
      ? sender?(sender.parentSubagentId?child(sender.parentSubagentId):root):undefined
      : targetId?child(targetId):matchingTargets.length===1?child(matchingTargets[0].id):undefined;
    if(scopeSubagentId&&source.id!==scopeSubagentId&&target?.id!==scopeSubagentId)continue;
    const sourceRuns=new Set(ordered.map(event=>event.runId||''));
    for(const runId of sourceRuns)for(const alias of group.aliases)toolIdentities.add(`${runId}:${alias}`);
    // Reports are explicit child-to-parent receipts. Without an operation/call
    // alias they cannot safely deduplicate a historical tool with similar text.
    const operationIds=new Set(ordered.flatMap(event=>[identity(event.data.operationId),identity(record(event.data.result).operationId)]).filter((value):value is string=>Boolean(value)));
    const receipt=receipts.find(event=>{
      const receiptOperation=identity(event.data.operationId),receiptCall=identity(event.data.toolCallId);
      if(receiptOperation&&operationIds.has(receiptOperation))return true;
      return Boolean(receiptCall&&ordered.some(tool=>tool.runId===event.runId
        && sourceId(tool)===sourceId(event)
        && [tool.data.toolCallId,record(tool.data.result).toolCallId].includes(receiptCall)));
    });
    if(receipt){
      for(const runId of sourceRuns)for(const value of [receipt.data.operationId,receipt.data.toolCallId])if(typeof value==='string'&&value)toolIdentities.add(`${runId}:${value}`);
      continue;
    }
    const runId=sourceEvent.runId||first.runId,runStatus=runs.get(runId||'')?.status;
    if(!status)status=returned?'completed':'running';
    if(pendingStatuses.has(status)){
      if(runStatus==='cancelled')status='cancelled';
      else if(!returned&&(runStatus==='failed'||runStatus==='interrupted'))status='interrupted';
      else if(!returned&&runStatus==='completed')status='unconfirmed';
    }
    const delivery=failureStatuses.has(status)?'failed':pendingStatuses.has(status)?'pending':'unconfirmed';
    items.push({key:`legacy-send:${operationId||`${runId||''}:${toolCallId}`}`,runId,createdAt:first.createdAt,source,...(target?{target}:{}),...(body!==undefined?{text:body}:{}),status,delivery,...(operationId?{operationId}:{}),...(toolCallId?{toolCallId}:{}),...(error?{error}:{})});
  }
  return {items,toolIdentities};
}
