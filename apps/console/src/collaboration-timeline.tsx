import {useState} from 'react';
import {ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon, MessageSquareIcon} from 'lucide-react';
import type {BotEvent, Message, Subagent} from '../../../packages/contracts/src/index';
import type {ChatCallbacks, ChatModel} from './chat-types';
import {MessageResponse} from './components/ai-elements/message';
import {agentColor} from './agent-colors';
import {collectLegacyAgentMessages} from './legacy-agent-messages';
import {ModelBadge} from './model-identity';
import './collaboration-timeline.css';

export type AgentLink = {id:string;name:string;kind:'bot'|'subagent';model?:string};
type Creation = {agent:AgentLink;status:string;task?:string;creator?:AgentLink};
type Notice = {direction:'from'|'to'|'between';agent:AgentLink;recipient?:AgentLink;text?:string;status?:string;messageId?:string;label?:string;error?:string;historical?:boolean};
export type CollaborationItem = {key:string;runId?:string;createdAt:string;creation?:Creation;notice?:Notice};
const record = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const text = (value:unknown) => typeof value==='string' ? value : '';
const statusLabel = (value:string) => value.replaceAll('_',' ');
const active = new Set(['queued','running','waiting_approval','waiting_connection']);

function reportBody(event:BotEvent,sourceName?:string):string {
  const body=text(event.data.text);
  // New events explicitly separate public content from model-only attribution.
  // Historical reports used these exact transport wrappers; other messages and
  // quoted/model-authored prefixes are never normalized by this projection.
  if(event.data.contentFormat!==undefined || !sourceName)return body;
  const hostPrefix=`Subagent ${sourceName}: `;
  if(!body.startsWith(hostPrefix))return body;
  const unwrapped=body.slice(hostPrefix.length);
  for(const prefix of [`Message from subagent ${sourceName}:\n`,`Subagent ${sourceName} completed its task:\n`]) {
    if(unwrapped.startsWith(prefix))return unwrapped.slice(prefix.length);
  }
  return unwrapped;
}

function AgentAvatar({agent}: {agent:AgentLink}) {
  return <span className={`timber-collaborator-avatar timber-model-avatar is-${agent.kind}`} data-agent-color={agentColor(agent.id)} aria-hidden="true">{agent.name.slice(0,1).toUpperCase()}<ModelBadge model={agent.model}/></span>;
}
function openAgent(agent:AgentLink,callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>) {
  if(agent.kind==='subagent') callbacks.onOpenAgents(agent.id);else callbacks.onOpenBot(agent.id);
}
export function AgentMessageNotice({notice,callbacks,eventKey,context='timeline'}: {notice:Notice;callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>;eventKey:string;context?:'timeline'|'activity'|'preview'}) {
  const [expanded,setExpanded]=useState(false);
  const identity=(agent:AgentLink)=><button type="button" className="timber-collaborator-link" aria-label={`Open ${agent.name} conversation`} aria-description={agent.model?`Model: ${agent.model}`:undefined} title={`${agent.name}${agent.model?` · ${agent.model}`:''}`} onClick={()=>openAgent(agent,callbacks)}><AgentAvatar agent={agent}/><strong>{agent.name}</strong></button>;
  const detail=Boolean(notice.text||notice.error),attributes=context==='activity'?{'data-activity-collaboration-notice':eventKey}:context==='preview'?{'data-preview-collaboration-notice':eventKey}:{'data-collaboration-notice':eventKey};
  return <article className="timber-collaboration-message" {...attributes} data-message-id={context==='timeline'?notice.messageId:undefined}>
    <div className="timber-collaboration-message-row timber-agent-source">
      {!notice.agent.id&&<MessageSquareIcon className="timber-collaboration-message-icon" aria-hidden="true"/>}
      <span className="timber-collaboration-direction">{notice.label||(notice.direction==='between'?'Messages from':`Messages ${notice.direction}`)}</span>{notice.agent.id&&identity(notice.agent)}
      {notice.recipient && <><ArrowRightIcon className="timber-collaboration-arrow" aria-label="to"/>{identity(notice.recipient)}</>}
      {notice.status && (notice.historical||active.has(notice.status)||['failed','interrupted','cancelled'].includes(notice.status)) && <span className="timber-collaboration-status" data-status={notice.status}>{statusLabel(notice.status)}</span>}
      {detail && <button type="button" className="timber-collaboration-disclosure" aria-expanded={expanded} aria-label={`${expanded?'Hide':'Show'} message ${notice.direction==='to'?'to':'from'} ${notice.agent.name}`} onClick={()=>setExpanded(value=>!value)}><ChevronDownIcon className={expanded?'is-expanded':''}/></button>}
    </div>
    {expanded && detail && <div className="timber-collaboration-message-body">{notice.text&&<MessageResponse className="timber-markdown" mode="static" skipHtml plugins={{}} components={{img:()=>null}} linkSafety={{enabled:false}} controls={false}>{notice.text}</MessageResponse>}{notice.error&&<p className="timber-inline-error">{notice.error}</p>}</div>}
  </article>;
}
export function AgentCreationCard({creation,callbacks,context='timeline'}: {creation:Creation;callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>;context?:'timeline'|'activity'}) {
  const [expanded,setExpanded]=useState(false);
  const kind=creation.agent.kind==='subagent'?'subagent':'named agent';
  return <article className="timber-agent-created" {...(context==='activity'?{'data-activity-agent-created':creation.agent.id}:{'data-agent-created':creation.agent.id})} data-agent-kind={creation.agent.kind}>
    <div className="timber-agent-created-pill">
      <button type="button" className="timber-agent-created-link" onClick={()=>openAgent(creation.agent,callbacks)} aria-label={`Open ${creation.agent.name} conversation`} aria-description={creation.agent.model?`Model: ${creation.agent.model}`:undefined} title={`Created ${kind}${creation.agent.model?` · ${creation.agent.model}`:''}${creation.task?` · ${creation.task}`:''}`}><GitBranchIcon className="timber-agent-created-icon" aria-hidden="true"/><AgentAvatar agent={creation.agent}/><strong>{creation.agent.name}</strong></button>
      <span className="status" data-status={creation.status}>{statusLabel(creation.status)}</span>
      <button type="button" className="timber-agent-created-toggle" onClick={()=>setExpanded(value=>!value)} aria-expanded={expanded} aria-label={`${expanded?'Hide':'Show'} ${creation.agent.name} agent details`}><ChevronDownIcon className={expanded?'is-expanded':''}/></button>
    </div>
    {expanded && <div className="timber-agent-created-details">
      <span className="timber-agent-created-caption">Created {kind}{creation.creator?` · by ${creation.creator.name}`:''}</span>
      {creation.agent.model&&<span className="timber-agent-created-caption">{creation.agent.model}</span>}
      {creation.task && <p className="timber-agent-created-task">{creation.task}</p>}
      <button type="button" className="timber-agent-created-open" onClick={()=>openAgent(creation.agent,callbacks)}>Open conversation<ChevronRightIcon aria-hidden="true"/></button>
    </div>}
  </article>;
}

export function provenanceNotice(message:Message,model:ChatModel):Notice | undefined {
  if(!message.provenance)return;
  return {direction:'from',agent:{id:message.provenance.sourceBotId,name:message.provenance.sourceBotName,kind:'bot',model:model.mentionBots.find(bot=>bot.id===message.provenance?.sourceBotId)?.model},text:message.text,messageId:message.id,status:model.runs.find(run=>run.id===message.runId)?.status};
}

/** Project durable product events. Never infer a sender from model-authored text. */
type CollaborationModel = Pick<ChatModel,'events'|'subagents'|'runs'|'mentionBots'|'delegations'|'messages'|'collaborationEvents'|'runFilter'> & {bot:Pick<ChatModel['bot'],'id'|'name'>&{model?:string}};
export function collectCollaboration(model:CollaborationModel,scopeSubagentId?:string) {
  const items=new Map<string,CollaborationItem>(),toolIdentities=new Set<string>();
  const events=model.collaborationEvents;
  const rootRun=(runId?:string):string|undefined=>{
    const visited=new Set<string>();let current=runId;
    while(current&&!visited.has(current)){visited.add(current);const run=model.runs.find(item=>item.id===current);if(!run?.subagentId||!run.parentRunId)return current;current=run.parentRunId;}
    return current;
  };
  const parentRun=(agent:Subagent,event?:BotEvent)=>rootRun(event?.runId || model.runs.find(run=>run.operationId===agent.parentOperationId || run.operationId===`subagent:${agent.parentOperationId}`)?.id);
  const childLink=(id:string,name?:string):AgentLink=>({id,name:name||model.subagents.find(agent=>agent.id===id)?.name||'Subagent',kind:'subagent',model:model.subagents.find(agent=>agent.id===id)?.model});
  const namedStatus=(id:string)=>model.delegations.filter(delegation=>delegation.targetBotId===id).sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt))[0]?.status||'created';
  const rootLink:AgentLink={id:model.bot.id,name:model.bot.name,kind:'bot',model:model.bot.model};
  const belongsToScope=(runId?:string)=>!scopeSubagentId || model.runs.some(run=>run.id===runId&&run.subagentId===scopeSubagentId);
  const correlation=(event:BotEvent,sourceRunId=event.runId)=>{
    const operation=text(event.data.operationId),call=text(event.data.toolCallId);
    const matching=operation?model.events.filter(tool=>tool.data.operationId===operation):[];
    const sourceRuns=matching.length?[...new Set(matching.map(tool=>tool.runId))]:[sourceRunId];
    for(const runId of sourceRuns){if(operation)toolIdentities.add(`${runId||''}:${operation}`);if(call)toolIdentities.add(`${runId||''}:${call}`);}
    // Durable operation IDs bridge native and host events. Opaque call IDs only
    // match within their own run; another run may reuse the same call ID.
    for(const tool of matching)for(const id of [tool.data.operationId,tool.data.toolCallId])if(typeof id==='string')toolIdentities.add(`${tool.runId||''}:${id}`);
  };
  const creations=new Map<string,BotEvent>();
  for(const event of events)if(event.type==='subagent.created'){const agent=record(event.data.subagent);if(typeof agent.id==='string'&&!creations.has(agent.id))creations.set(agent.id,event);}
  const temporary=new Map(model.subagents.map(agent=>[agent.id,agent]));
  for(const [id,event] of creations)if(!temporary.has(id))temporary.set(id,event.data.subagent as Subagent);
  for(const agent of temporary.values()){
    if(scopeSubagentId && agent.parentSubagentId!==scopeSubagentId)continue;
    const event=creations.get(agent.id);
    items.set(`created:subagent:${agent.id}`,{key:`created:subagent:${agent.id}`,createdAt:agent.createdAt,runId:parentRun(agent,event),creation:{agent:childLink(agent.id,agent.name),status:agent.status,task:agent.task,...(agent.parentSubagentId?{creator:childLink(agent.parentSubagentId)}:{})}});
    if(event){const source=model.runs.find(run=>run.operationId===agent.parentOperationId||run.operationId===`subagent:${agent.parentOperationId}`);const eventRun=model.runs.find(run=>run.id===event.runId);correlation(event,source?.id||(eventRun?.subagentId?eventRun.parentRunId:event.runId));}
  }
  for(const bot of model.mentionBots.filter(bot=>!scopeSubagentId&&bot.createdByBotId===model.bot.id)){
    items.set(`created:bot:${bot.id}`,{key:`created:bot:${bot.id}`,createdAt:bot.createdAt,creation:{agent:{id:bot.id,name:bot.name,kind:'bot',model:bot.model},status:namedStatus(bot.id),task:bot.instructions}});
  }
  for(const event of events)if(event.type==='agent.named.created'){
    if(!belongsToScope(event.runId))continue;
    const bot=record(event.data.bot),id=text(bot.id);if(!id)continue;
    const saved=items.get(`created:bot:${id}`),sourceRun=model.runs.find(run=>run.id===event.runId);
    items.set(`created:bot:${id}`,{key:`created:bot:${id}`,createdAt:saved?.createdAt||event.createdAt,runId:rootRun(event.runId),creation:{agent:{id,name:text(bot.name)||saved?.creation?.agent.name||'Named agent',kind:'bot',model:text(bot.model)||saved?.creation?.agent.model},status:namedStatus(id),task:saved?.creation?.task,...(sourceRun?.subagentId?{creator:childLink(sourceRun.subagentId)}:{})}});correlation(event);
  }
  const reports=new Map<string,BotEvent>();
  for(const event of events)if(event.type==='subagent.reported'&&typeof event.data.subagentId==='string')reports.set(text(event.data.operationId)||`event:${event.id}`,event);
  const sentOperations=new Set(events.filter(event=>event.type==='subagent.message.sent').map(event=>text(event.data.operationId)).filter(Boolean));
  for(const [identity,event] of reports){
    if(sentOperations.has(identity))continue;
    const id=text(event.data.subagentId);if(scopeSubagentId&&id!==scopeSubagentId)continue;
    const sourceName=text(event.data.subagentName)||model.subagents.find(agent=>agent.id===id)?.name;
    items.set(`reported:${identity}`,{key:`reported:${identity}`,createdAt:event.createdAt,runId:rootRun(event.runId),notice:{direction:scopeSubagentId?'to':'from',agent:scopeSubagentId?rootLink:childLink(id,sourceName),text:reportBody(event,sourceName)}});
  }
  for(const event of events)if(event.type==='subagent.message.sent'){
    const source=text(event.data.sourceSubagentId),target=text(event.data.targetSubagentId),identity=text(event.data.operationId)||`event:${event.id}`;
    if(!source&&!target)continue;
    if(scopeSubagentId){
      if(source!==scopeSubagentId&&target!==scopeSubagentId)continue;
      const outgoing=source===scopeSubagentId,other=outgoing?target:source,name=text(outgoing?event.data.targetName:event.data.sourceName);
      items.set(`sent:${identity}`,{key:`sent:${identity}`,createdAt:event.createdAt,runId:event.runId,notice:{direction:outgoing?'to':'from',agent:other?childLink(other,name):rootLink,text:text(event.data.text)}});correlation(event);continue;
    }
    const direction=source&&target?'between':source?'from':'to';
    items.set(`sent:${identity}`,{key:`sent:${identity}`,createdAt:event.createdAt,runId:rootRun(event.runId),notice:{direction,agent:direction==='to'?childLink(target,text(event.data.targetName)):childLink(source,text(event.data.sourceName)),...(direction==='between'?{recipient:childLink(target,text(event.data.targetName))}:{}),text:text(event.data.text)}});correlation(event);
  }
  const named=new Map(model.delegations.map(delegation=>[delegation.id,delegation]));
  for(const event of events)if(event.type==='delegation.updated'){
    const value=record(event.data.delegation);if(typeof value.id!=='string')continue;
    const current=named.get(value.id);if(!current||text(value.updatedAt)>=current.updatedAt)named.set(value.id,event.data.delegation as ChatModel['delegations'][number]);if(belongsToScope(text(value.sourceRunId)))correlation(event);
  }
  for(const delegation of named.values()){
    if(delegation.sourceBotId!==model.bot.id||!belongsToScope(delegation.sourceRunId))continue;
    const origin=events.find(event=>event.type==='delegation.updated'&&record(event.data.delegation).id===delegation.id);
    const sourceMessage=model.messages.find(message=>message.runId===delegation.sourceRunId&&message.role==='user'&&message.mentions?.includes(delegation.targetBotId));
    items.set(`delegation:${delegation.id}`,{key:`delegation:${delegation.id}`,createdAt:delegation.createdAt,runId:rootRun(delegation.sourceRunId),notice:{direction:'to',agent:{id:delegation.targetBotId,name:delegation.targetBotName,kind:'bot',model:model.mentionBots.find(bot=>bot.id===delegation.targetBotId)?.model},text:text(origin?.data.text)||sourceMessage?.text,status:delegation.status}});
  }
  const historical=collectLegacyAgentMessages(model,scopeSubagentId);
  for(const identity of historical.toolIdentities)toolIdentities.add(identity);
  for(const message of historical.items){
    let notice:Notice;
    const common={text:message.text,status:message.status,error:message.error,historical:true};
    if(!message.target)notice={...common,direction:'to',agent:{id:'',name:'Subagent',kind:'subagent'},label:'Message subagent'};
    else if(scopeSubagentId){const outgoing=message.source.id===scopeSubagentId;notice={...common,direction:outgoing?'to':'from',agent:outgoing?message.target:message.source};}
    else if(message.source.kind==='bot')notice={...common,direction:'to',agent:message.target};
    else if(message.target.kind==='bot')notice={...common,direction:'from',agent:message.source};
    else notice={...common,direction:'between',agent:message.source,recipient:message.target};
    const withModel=(agent:AgentLink):AgentLink=>({...agent,model:agent.kind==='subagent'?model.subagents.find(item=>item.id===agent.id)?.model:agent.id===model.bot.id?model.bot.model:model.mentionBots.find(item=>item.id===agent.id)?.model});
    notice.agent=withModel(notice.agent);if(notice.recipient)notice.recipient=withModel(notice.recipient);
    items.set(message.key,{key:message.key,runId:scopeSubagentId?message.runId:rootRun(message.runId),createdAt:message.createdAt,notice});
  }
  return {items:[...items.values()].filter(item=>!model.runFilter||item.runId===model.runFilter),toolIdentities};
}
