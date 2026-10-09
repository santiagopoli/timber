import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeftIcon, ArrowUpIcon, GitBranchIcon, LoaderCircleIcon, RefreshCwIcon} from 'lucide-react';
import type {AgentDelegation, Bot, BotEvent, Run, Subagent} from '../../../packages/contracts/src/index';
import {MessageResponse} from './components/ai-elements/message';
import {AgentCreationCard, AgentMessageNotice, collectCollaboration} from './collaboration-timeline';
import {mergeToolResult, mergeToolStatus} from './cancellation-presentation';
import {ModelBadge} from './model-identity';
import {agentColor} from './agent-colors';
import './agents.css';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const label = (value: string) => value.replaceAll('_', ' ');
const date = (value: string) => new Date(value).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
type AgentMessage = {id:string;role:'user'|'assistant'|'tool'|'system';text:string;createdAt?:string};
type AgentsModel = {botId: string; botName: string;botModel?:string; agents: Subagent[]; namedAgents:Bot[]; delegations: AgentDelegation[]; loading: boolean; error?: string; selectedAgentId: string | null; revision: number;events:BotEvent[];runs:Run[];collaborationEvents:BotEvent[]};
type AgentRequest = (botId: string, path: string, options?: {method?: string; body?: unknown; signal?: AbortSignal}) => Promise<unknown>;
type Callbacks = {request: AgentRequest; onSelect(id: string | null): void; onRefresh(): void; onOpenBot(botId: string): void};

function AgentActivity({events, agentId, hiddenIdentities}: {events:BotEvent[];agentId:string;hiddenIdentities:Set<string>}) {
  type AgentResult = {output?:string;error?:string;status?:string;checkpointStatus?:'pending'|'saved'|'failed'};
  type AgentTool = {event:BotEvent;process?:BotEvent;aliases:Set<string>;result?:AgentResult;status?:string};
  const tools = new Map<string, AgentTool>();
  for (const event of events) {
    if (event.data.subagentId !== agentId || !['subagent.tool.started','subagent.tool.completed','subagent.process.updated'].includes(event.type)) continue;
    const identities = [event.data.operationId,event.data.toolCallId,event.type==='subagent.process.updated'?event.data.processId:undefined].filter((id):id is string => typeof id === 'string' && Boolean(id)).map(id=>`${event.runId||''}:${id}`);
    if (!identities.length) continue;
    const matches = [...new Set(identities.map(id=>tools.get(id)).filter((item):item is AgentTool => Boolean(item)))];
    const tool: AgentTool = matches[0] || {event,aliases:new Set<string>()};
    for(const merged of matches.slice(1)) {
      if(merged.process && (!tool.process || merged.process.id>tool.process.id))tool.process=merged.process;
      tool.result=mergeToolResult(tool.result,merged.result);tool.status=mergeToolStatus(tool.status,merged.status);
      for(const alias of merged.aliases){tool.aliases.add(alias);tools.set(alias,tool);}
    }
    for(const id of identities){tool.aliases.add(id);tools.set(id,tool);}
    const previous=tool.result,previousStatus=previous?.status||tool.status;
    const incoming=event.data.result as AgentResult|undefined;
    const receivedStatus=typeof event.data.status==='string'?event.data.status:incoming?.status||(event.type==='subagent.tool.completed'&&!previousStatus?'completed':undefined);
    tool.status=mergeToolStatus(previousStatus,receivedStatus);
    if(event.data.result&&typeof event.data.result==='object')tool.result=mergeToolResult(previous,event.data.result as AgentResult,{snapshot:event.type==='subagent.process.updated'});
    if(event.type==='subagent.process.updated')tool.process=event;
    if(event.type==='subagent.tool.completed' || tool.event.type!=='subagent.tool.completed') tool.event={...event,data:{...tool.event.data,...event.data}};
  }
  if (!tools.size) return null;
  const records=[...new Set(tools.values())].filter(tool=>![...tool.aliases].some(id=>hiddenIdentities.has(id)) || tool.event.data.toolName!=='send_subagent_message'&&['failed','interrupted','cancelled'].includes(tool.result?.status||tool.status||''));
  if(!records.length)return null;
  return <details className="timber-agent-activity"><summary>Tool activity · {records.length}</summary>{records.map(({event: original,process,aliases,result:observed,status:observedStatus}) => {
    const event=process?{...original,type:process.type,data:{...original.data,...process.data,toolName:'exec'}}:original;
    const result = observed;
    const input = event.data.input && typeof event.data.input === 'object' ? event.data.input as Record<string,unknown> : {};
    const summary = ['command','path','url','key'].flatMap(key => typeof input[key] === 'string' ? [input[key] as string] : []).join(' · ');
    const status = result?.status || observedStatus || (event.type === 'subagent.tool.started' ? 'running' : 'completed');
    return <article key={[...aliases][0]}><div className="timber-agent-card-heading"><strong>{String(event.data.toolName || event.data.actionType || 'Tool')}</strong><span className="status" data-status={status}>{status==='running' && event.data.cancellationRequested?'Stopping…':label(status)}</span></div>{summary && <pre>{summary.slice(0,1000)}</pre>}{result?.checkpointStatus==='pending' && <p className="hint" data-checkpoint-status="pending">Saving files…</p>}{result?.output && <pre>{result.output.slice(0,4000)}</pre>}{result?.error && status!=='cancelled' && <p className={status==='completed'?'timber-save-warning':'error'}>{result.error}</p>}</article>;
  })}</details>;
}

function AgentConversation({model, agent, callbacks}: {model: AgentsModel; agent: Subagent; callbacks: Callbacks}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [loadError,setLoadError] = useState('');
  const pending = useRef<{operationId: string; text: string} | null>(null), mounted = useRef(true), requestVersion = useRef(0);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const path = `/agents/${encodeURIComponent(agent.id)}`;
  const reportFailure = [...model.events].reverse().find(event => event.type === 'subagent.report_failed' && event.data.subagentId === agent.id && typeof event.data.message === 'string');
  useEffect(() => {
    const controller = new AbortController(), version = ++requestVersion.current;
    void callbacks.request(model.botId, `${path}/messages`, {signal: controller.signal}).then(result => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setMessages((result as {messages: AgentMessage[]}).messages); setLoading(false);setLoadError('');
    }).catch(reason => {if (!controller.signal.aborted) {setLoadError(reason instanceof Error ? reason.message : 'Could not load this agent conversation.');setLoading(false);}});
    return () => controller.abort();
  }, [model.botId, model.revision, path, callbacks]);
  const send = async () => {
    if (busy || agent.status === 'cancelled' || !draft.trim()) return;
    const text = draft.trim(), submission = pending.current?.text === text ? pending.current : {operationId: crypto.randomUUID(), text};
    pending.current = submission; setBusy(true); setError('');
    try {
      await callbacks.request(model.botId, `${path}/messages`, {method: 'POST', body: submission});
      if (!mounted.current) return;
      pending.current = null;setDraft('');callbacks.onRefresh();
    } catch (reason) {if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not send this message.');}
    finally {if (mounted.current) setBusy(false);}
  };
  const cancel = async () => {
    setStopping(true);setError('');
    try {await callbacks.request(model.botId, `${path}/cancel`, {method:'POST'});if (mounted.current) callbacks.onRefresh();}
    catch (reason) {if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not stop this agent.');}
    finally {if (mounted.current) setStopping(false);}
  };
  const collaboration=collectCollaboration({bot:{id:model.botId,name:model.botName,model:model.botModel},events:model.events,subagents:model.agents,runs:model.runs,mentionBots:model.namedAgents,delegations:model.delegations,messages:[],collaborationEvents:model.collaborationEvents,runFilter:null},agent.id);
  const collaborationCallbacks={onOpenBot:callbacks.onOpenBot,onOpenAgents:(id?:string)=>callbacks.onSelect(id??null)};
  const timeline=[...messages.map((message,index)=>({key:`message:${message.id||index}`,createdAt:message.createdAt||agent.createdAt,node:<article className={`timber-agent-message timber-agent-message-${message.role}`} data-agent-message={message.id}>
    <div className="timber-message-meta"><strong>{(message.role === 'assistant' ? agent.name : message.role === 'user' ? 'Task / message' : label(message.role))}</strong>{message.createdAt && <time>{date(message.createdAt)}</time>}</div>
    <MessageResponse className="timber-markdown" mode="static" skipHtml plugins={{}} components={{img: () => null}} linkSafety={{enabled:false}} controls={false}>{message.text}</MessageResponse>
  </article>})),...collaboration.items.map(item=>({key:item.key,createdAt:item.createdAt,node:item.creation?<AgentCreationCard creation={item.creation} callbacks={collaborationCallbacks}/>:item.notice?<AgentMessageNotice notice={item.notice} callbacks={collaborationCallbacks} eventKey={item.key}/>:null}))].sort((left,right)=>(Date.parse(left.createdAt)||0)-(Date.parse(right.createdAt)||0));
  return <div className="timber-agent-detail" data-agent-detail={agent.id}>
    <div className="timber-agent-detail-heading"><button type="button" className="quiet icon-button" aria-label="Back to agents" onClick={() => callbacks.onSelect(null)}><ArrowLeftIcon/></button><span className="timber-collaborator-avatar timber-model-avatar is-subagent" data-agent-color={agentColor(agent.id)} title={agent.model} aria-hidden="true">{agent.name.slice(0,1)}<ModelBadge model={agent.model}/></span><div><h2>{agent.name}</h2><p className="hint">Temporary subagent · {model.botName}</p>{agent.model&&<p className="hint" data-agent-model={agent.model}>{agent.model}{agent.reasoningEffort?` · ${label(agent.reasoningEffort)} reasoning`:''}{agent.fast?' · Fast':''}</p>}</div><span className="spacer"/><span className="status" data-status={agent.status}>{label(agent.status)}</span></div>
    <div className="timber-agent-detail-actions"><button type="button" className="quiet" onClick={callbacks.onRefresh}><RefreshCwIcon/>Refresh</button>{!terminal.has(agent.status) && <button type="button" className="quiet" disabled={stopping} onClick={() => void cancel()}>{stopping ? 'Stopping…' : 'Stop agent'}</button>}</div>
    {['waiting_approval','waiting_connection'].includes(agent.status) && <p className="hint">This agent needs attention. <button type="button" className="text-button" onClick={() => callbacks.onOpenBot(model.botId)}>Open {model.botName}’s conversation</button></p>}
    {agent.error && <p className="error" role="status">{agent.error}</p>}
    {reportFailure && <div className="timber-agent-report-warning" role="status" data-agent-report-error={agent.id}><strong>Parent notification failed</strong><p>{String(reportFailure.data.message)}</p></div>}
    {(model.error || loadError) && <p className="error" role="alert">{model.error || loadError}</p>}
    <div className="timber-agent-messages" aria-label={`${agent.name} conversation`} aria-live="polite">
      {loading && <p className="hint">Loading conversation…</p>}
      {!loading&&!timeline.length&&<p className="hint">No messages yet.</p>}
      {timeline.map(entry=><div key={entry.key}>{entry.node}</div>)}
      <AgentActivity events={model.events} agentId={agent.id} hiddenIdentities={collaboration.toolIdentities}/>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {agent.status === 'cancelled' ? <p className="hint">This agent was stopped. Its conversation remains available; ask {model.botName} to create a new subagent for more work.</p> : <form className="timber-agent-composer" onSubmit={event => {event.preventDefault();void send();}}>
      <label htmlFor="agent-message" className="sr-only">Message {agent.name}</label><textarea id="agent-message" rows={2} value={draft} onChange={event => setDraft(event.currentTarget.value)} placeholder={`Message ${agent.name}…`}/>
      <button type="submit" aria-label={`Send message to ${agent.name}`} disabled={busy || !draft.trim()}>{busy ? <LoaderCircleIcon className="timber-spinner"/> : <ArrowUpIcon/>}</button>
    </form>}
  </div>;
}

function Agents({model, callbacks}: {model: AgentsModel; callbacks: Callbacks}) {
  const selected = model.agents.find(agent => agent.id === model.selectedAgentId);
  if (selected) return <AgentConversation key={`${model.botId}:${selected.id}`} model={model} agent={selected} callbacks={callbacks}/>;
  return <div className="timber-agents">
    <div className="section-title"><h2>Agents</h2><button type="button" className="quiet" onClick={callbacks.onRefresh}>Refresh</button></div>
    {model.error && <p className="error" role="alert">{model.error}</p>}
    <h3>Temporary subagents</h3>
    {!model.agents.length && <p className="hint">{model.loading ? 'Loading agents…' : 'Subagents created for this bot’s tasks appear here, with their conversations and progress.'}</p>}
    <div className="timber-agent-list">{model.agents.map(agent => <button type="button" key={agent.id} className="timber-agent-card" data-agent-id={agent.id} onClick={() => callbacks.onSelect(agent.id)}>
      <span className="timber-agent-card-heading"><span className="timber-collaborator-avatar timber-model-avatar is-subagent" data-agent-color={agentColor(agent.id)} title={agent.model} aria-hidden="true">{agent.name.slice(0,1)}<ModelBadge model={agent.model}/></span><strong>{agent.name}</strong><span className="status" data-status={agent.status}>{label(agent.status)}</span></span>
      <span className="hint">{agent.parentSubagentId ? `Subagent of ${model.agents.find(item => item.id === agent.parentSubagentId)?.name || 'another agent'}` : `Created by ${model.botName}`}</span>
      {agent.model&&<span className="hint" data-agent-model={agent.model}>{agent.model}</span>}
      <span className="timber-agent-task">{agent.task}</span>
      {agent.error && <span className="error">{agent.error}</span>}<span className="timber-agent-card-footer"><time>{date(agent.updatedAt)}</time><span>Open conversation →</span></span>
    </button>)}</div>
    {model.namedAgents.length > 0 && <><h3>Named agents</h3><div className="timber-agent-list">{model.namedAgents.map(bot=><button type="button" className="timber-agent-card" key={bot.id} data-named-agent={bot.id} onClick={()=>callbacks.onOpenBot(bot.id)}><span className="timber-agent-card-heading"><strong>{bot.name}</strong><span className="hint">Persistent bot</span></span><span className="timber-agent-task">{bot.instructions || `Created by ${model.botName}`}</span><span className="timber-agent-card-footer">Open conversation →</span></button>)}</div></>}
    <h3>Bot collaboration</h3>
    {!model.delegations.length && <p className="hint">Mention another bot with @ in chat, or ask this bot to delegate a task.</p>}
    <div className="timber-agent-list">{model.delegations.map(delegation => <article key={delegation.id} className="timber-agent-card" data-delegation-id={delegation.id}>
      <div className="timber-agent-card-heading"><strong>{delegation.sourceBotName} → {delegation.targetBotName}</strong><span className="status" data-status={delegation.status}>{label(delegation.status)}</span></div>
      {delegation.error && <p className="error">{delegation.error}</p>}<div className="timber-agent-card-footer"><time>{date(delegation.updatedAt)}</time><button type="button" className="quiet" onClick={() => callbacks.onOpenBot(delegation.targetBotId === model.botId ? delegation.sourceBotId : delegation.targetBotId)}>Open {delegation.targetBotId === model.botId ? delegation.sourceBotName : delegation.targetBotName}</button></div>
    </article>)}</div>
  </div>;
}

export function mountAgents(element: HTMLElement, callbacks: Callbacks) {
  const root = createRoot(element);
  return {update(model: AgentsModel) {root.render(<Agents key={model.botId} model={model} callbacks={callbacks}/>);}, clear() {root.render(null);}};
}
