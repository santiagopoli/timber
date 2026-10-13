import {createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {ArrowLeftIcon, ArrowUpIcon, CheckSquareIcon, InfoIcon, ListFilterIcon, LoaderCircleIcon, MonitorIcon, PlusIcon, RefreshCwIcon, SearchIcon, SquareIcon, XIcon} from 'lucide-react';
import {createDesktopViewer} from './desktop';
import {Dialog,Popover} from 'radix-ui';
import type {AgentDelegation,Approval, Bot, BotEvent, CompactionReceipt, Message, Run,Subagent,TaskQueue} from '../../../packages/contracts/src/index';
import {Agents} from './agents';
import {ConversationChat} from './chat';
import type {ArtifactLoader} from './artifact-preview';
import type {ChatCallbacks,ChatConnection,ChatModel,MessageDelivery} from './chat-types';
import type {ModelSelection,ModelSettingsState} from './model-settings';
import './tasks.css';

type RequestOptions = {method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean};
export type TasksRequest = (path: string, options?: RequestOptions) => Promise<unknown>;
export type TasksBot = Pick<Bot,'id'|'name'> & Partial<Bot>;
export type TasksProps = {
  request: TasksRequest;
  bots: TasksBot[];
  onOpenBot?: (botId: string) => void;
  selectedTaskId?: string|null;
  active?: boolean;
  onSelectTask?: (taskId:string|null) => void;
  loadArtifact?: ArtifactLoader;
  listContainer?: HTMLElement;
  modelSettings?:ModelSettingsState;
  onModelSettings?:(botId:string,settings:ModelSelection)=>Promise<void>;
  onRefreshModels?:()=>void;
  onOpenSettings?:()=>void;
  onBotUpdated?:(bot:Bot)=>void;
  decorateAvatar?:(node:HTMLElement,botId:string)=>void;
};
type TaskStatus = 'pending'|'queued'|'running'|'waiting_approval'|'waiting_connection'|'cancelling'|'completed'|'failed'|'cancelled'|string;
type Task = {id:string;title:string;description?:string;botId:string;botName?:string;status:TaskStatus;createdAt?:string;updatedAt?:string;lastActivity?:string;queue?:TaskQueue;computerMode?:string};
type TaskFilter = 'all'|'active'|'pending'|'completed';
type TaskApproval = Approval;
type TaskMessage = Message;
type TaskFiles=NonNullable<Parameters<ChatCallbacks['onSend']>[3]>;
type TaskSendOperation={key:string;id:string;imageIds:string[];attachments?:string[];endpoint:string};
type TaskDelivery=MessageDelivery & {files?:TaskFiles;nativeOperationId?:string;receipt?:TaskSendOperation};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown) => typeof value === 'string' ? value : '';
const label = (value: string) => value.replaceAll('_',' ');
const date = (value?: string) => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const activeStatuses = new Set(['queued','running','waiting_approval','waiting_connection','cancelling']);
const statusName = (status: string) => (({pending:'Pending',queued:'Queued',running:'Running',waiting_approval:'Needs approval',waiting_connection:'Needs connection',cancelling:'Cancelling',completed:'Completed',failed:'Failed',cancelled:'Cancelled'} as Record<string,string>)[status] || label(status));
const queueName=(task:Task)=>task.queue?.reason==='task'?`Waiting for ${task.queue.blockingTask?.title||'another task'}`:task.queue?.reason==='bot'?`Waiting for ${task.botName||'the bot'} to finish its current work`:task.queue?.reason==='direct_action'?'Waiting for a computer action to finish':task.queue?.reason==='starting'?'Starting…':'Waiting to start';
function queueValue(value:unknown):TaskQueue|undefined {
  if(!isRecord(value)||!['task','bot','direct_action','starting','scheduled'].includes(text(value.reason)))return;
  const blocker=isRecord(value.blockingTask)?value.blockingTask:undefined;
  return {reason:value.reason as TaskQueue['reason'],...(blocker&&text(blocker.id)&&text(blocker.title)?{blockingTask:{id:text(blocker.id),title:text(blocker.title)}}:{})};
}
function taskList(value: unknown): Task[] {
  const source = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.tasks) ? value.tasks : [];
  return source.filter(isRecord).map(item => ({id:text(item.id),title:text(item.title)||'Untitled task',description:text(item.description),botId:text(item.botId),botName:text(item.botName),status:text(item.status)||'pending',createdAt:text(item.createdAt),updatedAt:text(item.updatedAt),lastActivity:text(item.lastActivity),computerMode:text(item.computerMode),queue:queueValue(item.queue)})).filter(item=>item.id);
}
function taskDetail(value: unknown): Task | undefined {
  const candidate = isRecord(value) && isRecord(value.task) ? value.task : value;
  return taskList([candidate])[0];
}
function messageList(value: unknown): TaskMessage[] {
  const source = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  return source.filter(isRecord).map(item=>({...item,id:text(item.id),botId:text(item.botId),runId:text(item.runId),role:text(item.role)||'assistant',text:text(item.text)||text(item.content),createdAt:text(item.createdAt)} as Message));
}
function mergeMessages(previous:TaskMessage[],incoming:TaskMessage[],older=false){
  const known=new Set(previous.map(message=>message.id));
  const added=incoming.filter(message=>!message.id||!known.has(message.id));
  if(!added.length)return previous;
  return (older?[...added,...previous]:[...previous,...added]).slice(older?0:-500,older?500:undefined);
}
function approvalList(value: unknown): TaskApproval[] {
  const source = isRecord(value) && Array.isArray(value.approvals) ? value.approvals : [];
  return source.filter(isRecord).filter(item=>item.id) as unknown as TaskApproval[];
}
const approvalExpired = (approval:TaskApproval) => Boolean(approval.expiresAt && Date.parse(approval.expiresAt)<=Date.now());

function TaskAvatar({bot,decorate}:{bot:TasksBot|undefined;decorate:TasksProps['decorateAvatar']}) {
  const ref=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{if(ref.current&&bot)decorate?.(ref.current,bot.id)},[bot,decorate]);
  return <span ref={ref} className="avatar timber-task-avatar" data-bot-id={bot?.id} aria-hidden="true">{bot?.name.slice(0,1).toUpperCase()||'T'}</span>;
}
function TaskDesktop({taskId,request}:{taskId:string;request:TasksRequest}) {
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!ref.current)return;
    const path=`/v1/tasks/${encodeURIComponent(taskId)}/computer/live-session`;
    const viewer=createDesktopViewer({element:ref.current,dockId:`task-desktop-dock-${taskId}`,
      connect:async(mode,replaces)=>{
        const data=await request(path,{method:'POST',body:{mode,...(replaces?{replaces}:{})}});
        if(!isRecord(data)||typeof data.sessionId!=='string'||!Array.isArray(data.protocols)||!data.protocols.every(p=>typeof p==='string')||typeof data.expiresAt!=='string')throw new Error('Could not connect to the task computer.');
        const url=new URL(`/v1/tasks/${encodeURIComponent(taskId)}/computer/live`,location.origin);url.protocol=location.protocol==='https:'?'wss:':'ws:';
        return {sessionId:data.sessionId,protocols:data.protocols as string[],expiresAt:data.expiresAt,url:url.href};
      },
      renew:async sessionId=>await request(`${path}/${encodeURIComponent(sessionId)}/renew`,{method:'POST',body:{}}) as {expiresAt:string},
      release:sessionId=>request(`${path}/${encodeURIComponent(sessionId)}`,{method:'DELETE'}),
    });
    viewer.setActive(true);return()=>viewer.destroy();
  },[taskId,request]);
  return <div ref={ref} className="timber-task-desktop"/>;
}

function TaskView({props}:{props:TasksProps}) {
  const [wide,setWide]=useState(()=>matchMedia('(min-width:761px)').matches);
  useEffect(()=>{const query=matchMedia('(min-width:761px)'),update=()=>setWide(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[]);
  const [tasks,setTasks]=useState<Task[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Task|null>(null),[messages,setMessages]=useState<TaskMessage[]>([]);
  const [loading,setLoading]=useState(true),[loadingMessages,setLoadingMessages]=useState(false),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState(''),[showCreate,setShowCreate]=useState(false),[filter,setFilter]=useState<TaskFilter>('all');
  const [filtersOpen,setFiltersOpen]=useState(false);
  const [approvals,setApprovals]=useState<TaskApproval[]>([]),[approvalError,setApprovalError]=useState('');
  const [search,setSearch]=useState(''),[events,setEvents]=useState<BotEvent[]>([]),[runs,setRuns]=useState<Run[]>([]),[detailsOpen,setDetailsOpen]=useState(false);
  const [desktopOpen,setDesktopOpen]=useState(false);
  const [subagents,setSubagents]=useState<Subagent[]>([]),[delegations,setDelegations]=useState<AgentDelegation[]>([]),[agentsOpen,setAgentsOpen]=useState(false),[selectedAgent,setSelectedAgent]=useState<string|null>(null);
  const [connections,setConnections]=useState<ChatConnection[]>([]),[compactions,setCompactions]=useState<CompactionReceipt[]>([]),[deliveries,setDeliveries]=useState<TaskDelivery[]>([]),[draftMentions,setDraftMentions]=useState<string[]>([]),[acceptedImageIds,setAcceptedImageIds]=useState<string[]>([]);
  const [headerTarget,setHeaderTarget]=useState<HTMLElement|null>(null),avatarRef=useRef<HTMLSpanElement>(null);
  const bridge=useRef<ChatCallbacks|null>(null),busyRef=useRef(false),detailRef=useRef(detail);detailRef.current=detail;
  const [partials,setPartials]=useState<Record<string,string>>({}),partialRef=useRef<Record<string,string>>({}),knownRuns=useRef(new Map<string,Run>());
  const [messageCursor,setMessageCursor]=useState<string|null>(null),[eventCursor,setEventCursor]=useState<string|null>(null),[olderBusy,setOlderBusy]=useState(false),[visibleMessages,setVisibleMessages]=useState(100),[archivedActivity,setArchivedActivity]=useState(false);
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[botId,setBotId]=useState(props.bots[0]?.id||''),[startImmediately,setStartImmediately]=useState(true),[draft,setDraft]=useState('');
  const draftState=useRef({text:draft,mentions:draftMentions});draftState.current={text:draft,mentions:draftMentions};
  const createOperation=useRef<{key:string;id:string}|null>(null),sendOperation=useRef<TaskSendOperation|null>(null),mounted=useRef(true);
  const selectedRef=useRef<string|null>(null),viewVersion=useRef(0),tasksRef=useRef(tasks);
  const listRead=useRef<AbortController|null>(null),detailRead=useRef<AbortController|null>(null),olderRead=useRef<AbortController|null>(null);
  const propsRef=useRef(props),eventsRef=useRef(events),messageCursorRef=useRef(messageCursor),eventCursorRef=useRef(eventCursor),streamCursor=useRef(0),archiveRef=useRef(archivedActivity),olderMessagesLoaded=useRef(false);
  propsRef.current=props;eventsRef.current=events;messageCursorRef.current=messageCursor;eventCursorRef.current=eventCursor;archiveRef.current=archivedActivity;
  const request=useCallback((path:string,options?:RequestOptions)=>propsRef.current.request(path,options),[]);
  const active=props.active!==false;
  tasksRef.current=tasks;
  useEffect(()=>{
    // The task island can mount before the bot catalogue arrives, or outlive a bot.
    if(!props.bots.some(bot=>bot.id===botId))setBotId(props.bots[0]?.id||'');
  },[props.bots,botId]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;listRead.current?.abort();detailRead.current?.abort();olderRead.current?.abort()};
  },[]);
  const selectTask=(id:string|null,notify=true)=>{
    setDesktopOpen(false);
    // Fence the old view synchronously, including switching away and back to the same task.
    viewVersion.current++;selectedRef.current=id;listRead.current?.abort();detailRead.current?.abort();olderRead.current?.abort();setSelected(id);
    setDetail(null);setMessages([]);setApprovals([]);setEvents([]);setRuns([]);setConnections([]);setSubagents([]);setDelegations([]);setAgentsOpen(false);setSelectedAgent(null);setCompactions([]);setDeliveries([]);setDraftMentions([]);setAcceptedImageIds([]);setDetailsOpen(false);busyRef.current=false;knownRuns.current.clear();partialRef.current={};setPartials({});setMessageCursor(null);setEventCursor(null);streamCursor.current=0;olderMessagesLoaded.current=false;setVisibleMessages(100);setOlderBusy(false);setArchivedActivity(false);setDraft('');setBusy(false);setError('');setLoadError('');setApprovalError('');
    if(notify)propsRef.current.onSelectTask?.(id);
  };
  useEffect(()=>{const id=props.selectedTaskId??null;if(id!==selectedRef.current)selectTask(id,false)},[props]);
  const loadTasks=useCallback(async()=>{
    if(!mounted.current)return;
    listRead.current?.abort();const controller=new AbortController();listRead.current=controller;
    const current=()=>mounted.current&&!controller.signal.aborted&&listRead.current===controller;
    try {
      const result=await request('/v1/tasks',{signal:controller.signal});
      if(current()){setTasks(taskList(result));setLoadError('');}
    }
    catch(reason){if(current())setLoadError(reason instanceof Error?reason.message:'Could not load tasks.');}
    finally{if(current())setLoading(false);}
  },[request]);
  useEffect(()=>{if(active)void loadTasks();return()=>listRead.current?.abort()},[active,loadTasks]);
  useEffect(()=>{if(selected&&!wide||!active)return;const timer=setInterval(()=>{if(!document.hidden)void loadTasks()},8000);return()=>{listRead.current?.abort();clearInterval(timer)}},[selected,wide,active,loadTasks]);
  const loadDetail=useCallback(async(id:string)=>{
    if(!mounted.current||selectedRef.current!==id)return;
    detailRead.current?.abort();const controller=new AbortController();detailRead.current=controller;
    const version=viewVersion.current;
    const current=()=>mounted.current&&!controller.signal.aborted&&detailRead.current===controller&&selectedRef.current===id&&viewVersion.current===version;
    setLoadingMessages(true);
    try {
      const path=`/v1/tasks/${encodeURIComponent(id)}`,options={signal:controller.signal};
      const [taskResult,messageResult,approvalResult,runResult,eventResult,connectionResult,agentResult]=await Promise.all([
        request(path,options),request(`${path}/messages?limit=100`,options),
        request(`${path}/approvals`,options).then(value=>({value,error:''}),reason=>({value:null,error:reason instanceof Error?reason.message:'Could not load task approvals.'})),
        request(`${path}/runs?limit=100`,options),streamCursor.current?Promise.resolve(null):request(`${path}/events?format=json&view=activity&limit=100`,options),
        request(`${path}/connections`,options),request(`${path}/agents`,options),
      ]);
      if(!current())return;
      setDetail(taskDetail(taskResult)||tasksRef.current.find(item=>item.id===id)||null);setMessages(previous=>mergeMessages(previous,messageList(messageResult)));setLoadError('');
      if(isRecord(messageResult)&&!olderMessagesLoaded.current)setMessageCursor(text(messageResult.nextCursor)||null);
      if(isRecord(runResult)&&Array.isArray(runResult.runs)){const incoming=runResult.runs as Run[];knownRuns.current=new Map(incoming.map(run=>[run.id,run]));setRuns(incoming);setDeliveries(previous=>previous.map(item=>{const run=incoming.find(run=>run.operationId===(item.nativeOperationId||item.operationId));return run?{...item,state:'accepted',files:undefined,runId:run.id,runStatus:run.status}:item}))}
      if(isRecord(agentResult)){if(Array.isArray(agentResult.agents))setSubagents(agentResult.agents as Subagent[]);if(Array.isArray(agentResult.delegations))setDelegations(agentResult.delegations as AgentDelegation[]);}
      if(isRecord(connectionResult)&&Array.isArray(connectionResult.connections))setConnections(previous=>(connectionResult.connections as ChatConnection[]).map(item=>({...previous.find(old=>old.id===item.id),...item})));
      if(isRecord(eventResult)&&Array.isArray(eventResult.events)){
        const incoming=eventResult.events as BotEvent[];setEvents(incoming);setEventCursor(text(eventResult.nextCursor)||null);
        // Activity IDs omit text deltas. Bootstrap the live stream from its
        // bounded tail, rather than replaying every delta since the last tool.
      }
      setApprovalError(approvalResult.error);if(!approvalResult.error)setApprovals(approvalList(approvalResult.value));
    } catch(reason){if(current())setLoadError(reason instanceof Error?reason.message:'Could not load task conversation.');}
    finally{if(current())setLoadingMessages(false);}
  },[request]);
  useEffect(()=>{
    if(!selected||!active)return;
    void loadDetail(selected);const timer=setInterval(()=>{if(!document.hidden)void loadDetail(selected)},8000);
    return()=>{detailRead.current?.abort();olderRead.current?.abort();clearInterval(timer)};
  },[selected,active,loadDetail]);
  useEffect(()=>{
    if(!selected||!active||detail?.id!==selected)return;
    const controller=new AbortController(),id=selected,version=viewVersion.current;
    let reconnect:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined,pending:BotEvent[]=[],pendingMessages:TaskMessage[]=[],pendingRuns:Run[]=[],partialChanged=false,activeReader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const pause=()=>{if(document.hidden)void activeReader?.cancel().catch(()=>{})};
    document.addEventListener('visibilitychange',pause);
    const current=()=>!controller.signal.aborted&&mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    const commit=()=>{
      flush=undefined;if(!current())return;
      if(pendingMessages.length){const added=pendingMessages;pendingMessages=[];setMessages(previous=>mergeMessages(previous,added));setVisibleMessages(value=>Math.min(500,value+added.length))}
      if(pendingRuns.length){const added=pendingRuns;pendingRuns=[];setRuns(previous=>{const changes=new Map(added.map(run=>[run.id,run]));return [...previous.filter(run=>!changes.has(run.id)),...changes.values()].slice(-100)})}
      if(partialChanged){partialChanged=false;setPartials({...partialRef.current})}
      if(!pending.length)return;
      const batch=pending;pending=[];
      setEvents(previous=>{const seen=new Set(previous.map(event=>event.id));const merged=[...previous,...batch.filter(event=>!seen.has(event.id))];if(merged.length>500)setEventCursor(String(merged[merged.length-500]!.id));return merged.slice(-500)});
    };
    const record=(event:BotEvent)=>{
      const data=event.data;
      if(event.type==='stream.snapshot'&&Number.isSafeInteger(data.latestEventId)&&Number(data.latestEventId)>=streamCursor.current){
        streamCursor.current=Number(data.latestEventId);partialRef.current={};
        if(Array.isArray(data.partials))for(const partial of data.partials.slice(0,16))if(isRecord(partial)&&typeof partial.runId==='string'&&typeof partial.text==='string'&&!['completed','failed','cancelled','interrupted'].includes(knownRuns.current.get(partial.runId)?.status||''))partialRef.current[partial.runId]=partial.text.slice(-65_536);
        partialChanged=true;
      }else{
        if(!Number.isSafeInteger(event.id)||Number(event.id)<=streamCursor.current)return;streamCursor.current=Number(event.id);
        if(!['message.delta','runtime.snapshot','message.created','run.updated'].includes(event.type)){pending.push(event);if(pending.length>200)pending=pending.slice(-200)}
        if(event.type==='message.created'&&isRecord(data.message)&&typeof data.message.id==='string'&&typeof data.message.text==='string'&&['user','assistant','tool','system'].includes(String(data.message.role))){pendingMessages.push(...messageList([data.message]));if(pendingMessages.length>200)pendingMessages=pendingMessages.slice(-200);if(data.message.role==='assistant'&&event.runId){delete partialRef.current[event.runId];partialChanged=true}}
        if(['approval.created','approval.updated'].includes(event.type)&&isRecord(data.approval)){const approval=data.approval as unknown as Approval;setApprovals(previous=>[...previous.filter(item=>item.id!==approval.id),approval].slice(-100))}
        if(event.type==='connection.updated'&&isRecord(data.request)){const connection=data.request as unknown as ChatConnection;setConnections(previous=>[...previous.filter(item=>item.id!==connection.id),connection].slice(-100))}
        if(event.type==='run.updated'&&isRecord(data.run)&&typeof data.run.id==='string'&&typeof data.run.status==='string'){const run=data.run as unknown as Run;knownRuns.current.set(run.id,run);if(knownRuns.current.size>100)knownRuns.current.delete(knownRuns.current.keys().next().value!);pendingRuns.push(run);if(['completed','failed','cancelled','interrupted'].includes(run.status)){delete partialRef.current[run.id];partialChanged=true}}
        if(!data.subagentId&&event.runId&&!['completed','failed','cancelled','interrupted'].includes(knownRuns.current.get(event.runId)?.status||'')){
          if(event.type==='message.delta'&&typeof data.delta==='string'){partialRef.current[event.runId]=((partialRef.current[event.runId]||'')+data.delta).slice(-65_536);partialChanged=true}
          if(event.type==='runtime.snapshot'&&typeof data.partialText==='string'){if(data.busy===false)delete partialRef.current[event.runId];else partialRef.current[event.runId]=data.partialText.slice(-65_536);partialChanged=true}
        }
      }
      if(!flush)flush=setTimeout(commit,80);
    };
    const connect=async()=>{
      if(!current()||document.hidden){if(current())reconnect=setTimeout(()=>void connect(),1000);return}
      let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      try{
        const response=await request(`/v1/tasks/${encodeURIComponent(id)}/events?after=${streamCursor.current}&tail=100`,{raw:true,signal:controller.signal});
        if(!(response instanceof Response)||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Task activity stream unavailable.');
        reader=response.body.getReader();activeReader=reader;const decoder=new TextDecoder();let buffer='',data='';
        while(current()){
          const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
          if(buffer.length>2_000_000)throw new Error('Task activity response is too large.');
          let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
            if(line.startsWith('data:'))data+=line.slice(5).trimStart();
            else if(!line&&data){try{record(JSON.parse(data) as BotEvent)}catch{/* Ignore malformed product events. */}data=''}
          }
        }
      }catch{/* The bounded snapshot poll still exposes durable task state. */}
      finally{if(reader)await reader.cancel().catch(()=>{});activeReader=undefined;commit();if(current())reconnect=setTimeout(()=>void connect(),1000)}
    };
    void connect();return()=>{controller.abort();document.removeEventListener('visibilitychange',pause);if(reconnect)clearTimeout(reconnect);if(flush)clearTimeout(flush)};
  },[selected,active,detail?.id,request]);
  const loadOlder=async(kind:'messages'|'events')=>{
    const id=selected,cursor=kind==='messages'?messageCursorRef.current:eventCursorRef.current;if(!id||!cursor||olderBusy)return;
    const version=viewVersion.current,controller=new AbortController();olderRead.current?.abort();olderRead.current=controller;setOlderBusy(true);setError('');
    try{
      const result=await request(`/v1/tasks/${encodeURIComponent(id)}/${kind}?${kind==='events'?'format=json&view=activity&':''}limit=100&before=${encodeURIComponent(cursor)}`,{signal:controller.signal});
      if(controller.signal.aborted||!mounted.current||selectedRef.current!==id||viewVersion.current!==version||!isRecord(result))return;
      const next=text(result.nextCursor)||null;if(next&&(!/^\d+$/.test(next)||Number(next)>=Number(cursor)))throw new Error('Task history cursor did not advance.');
      if(kind==='messages'){olderMessagesLoaded.current=true;setMessages(previous=>mergeMessages(previous,messageList(result),true));setMessageCursor(next);setVisibleMessages(value=>Math.min(500,value+100))}
      else if(Array.isArray(result.events)){archiveRef.current=true;setArchivedActivity(true);setEvents(previous=>{const unique=new Map(previous.map(event=>[event.id,event]));for(const event of result.events as BotEvent[])unique.set(event.id,event);return [...unique.values()].sort((a,b)=>a.id-b.id).slice(0,500)});setEventCursor(next)}
    }catch(reason){if(!controller.signal.aborted&&mounted.current&&selectedRef.current===id&&viewVersion.current===version)setError(reason instanceof Error?reason.message:'Could not load task history.')}
    finally{if(mounted.current&&selectedRef.current===id&&viewVersion.current===version)setOlderBusy(false)}
  };
  const latestActivity=()=>{archiveRef.current=false;setArchivedActivity(false);streamCursor.current=0;if(selected)void loadDetail(selected)};
  const refresh=()=>{void loadTasks();if(selected)void loadDetail(selected)};
  const create=async(event:FormEvent)=>{
    event.preventDefault();const trimmed=title.trim(),trimmedDescription=description.trim();if(!trimmed||!botId||creating)return;
    const key=JSON.stringify([trimmed,trimmedDescription,botId,startImmediately]);
    const operation=createOperation.current?.key===key?createOperation.current:{key,id:crypto.randomUUID()};createOperation.current=operation;
    const version=viewVersion.current;
    setCreating(true);setError('');
    try {
      const result=await props.request('/v1/tasks',{method:'POST',body:{operationId:operation.id,title:trimmed,description:trimmedDescription,botId,startImmediately}});
      if(!mounted.current)return;
      const created=taskDetail(result);createOperation.current=null;setTitle('');setDescription('');setShowCreate(false);setStartImmediately(true);await loadTasks();
      if(mounted.current&&viewVersion.current===version&&created?.id)selectTask(created.id);
    } catch(reason){if(mounted.current&&viewVersion.current===version)setError(reason instanceof Error?reason.message:'Could not create task.');}
    finally{if(mounted.current)setCreating(false);}
  };
  const send=async(rawText:string,mentions:string[]=[],files:TaskFiles=[],retry?:TaskSendOperation)=>{
    const value=rawText.trim(),id=selectedRef.current,task=detailRef.current;if(!id||!task||(!value&&!files.length)||busyRef.current)return;
    if(['cancelled','cancelling'].includes(task.status)||!retry&&task.status==='pending')throw new Error('This task is not accepting messages. Review its details.');
    const key=JSON.stringify([id,value,mentions,files.map(file=>[(file as typeof file&{id?:string}).id||file.url,file.mediaType,file.filename])]);
    if(retry&&retry.key!==key&&!(retry.attachments?.length&&!files.length&&JSON.stringify(JSON.parse(retry.key).slice(0,3))===JSON.stringify([id,value,mentions])))throw new Error('The recorded message changed. Send it as a new request.');
    const operation:TaskSendOperation=retry||(sendOperation.current?.key===key?sendOperation.current:{key,id:crypto.randomUUID(),imageIds:files.map(()=>crypto.randomUUID()),endpoint:['completed','failed'].includes(task.status)?'continue':'messages'});sendOperation.current=operation;
    const version=viewVersion.current,current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    const delivery:TaskDelivery={botId:task.botId,operationId:operation.id,text:value,mentions,files,createdAt:new Date().toISOString(),state:'sending',receipt:operation};
    busyRef.current=true;setBusy(true);setError('');setDeliveries(previous=>[...previous.filter(item=>item.operationId!==operation.id),delivery].slice(-16));
    try {
      if(!operation.attachments){
        operation.attachments=[];
        try {for(const [index,file] of files.entries()){
          if(!/^data:image\/(png|jpeg);base64,/.test(file.url))throw new Error('Only PNG and JPEG images are supported.');
          const [header,encoded]=file.url.split(','),bytes=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));
          if(bytes.length>5_000_000)throw new Error('Images must be at most 5 MB.');
          await request(`/v1/bots/${encodeURIComponent(task.botId)}/attachments/${operation.imageIds[index]}`,{method:'PUT',body:new Blob([bytes],{type:header.slice(5,header.indexOf(';'))})});operation.attachments.push(operation.imageIds[index]!);
        }}catch(reason){delete operation.attachments;throw reason;}
      }
      const result=await request(`/v1/tasks/${encodeURIComponent(id)}/${operation.endpoint}`,{method:'POST',body:{operationId:operation.id,text:value,...(operation.attachments.length?{attachments:operation.attachments}:{}),...(mentions.length?{mentions}:{})}});
      const run=isRecord(result)&&isRecord(result.run)?result.run as unknown as Run:undefined;
      if(operation.endpoint==='messages'&&(!run?.id||run.botId!==task.botId||run.operationId!==operation.id)||operation.endpoint==='continue'&&(!isRecord(result)||!isRecord(result.task)||result.task.id!==id))throw new Error('The server acknowledgment could not be verified. Retry the same recorded message to confirm it safely.');
      if(sendOperation.current===operation)sendOperation.current=null;
      if(!current())return;
      const nativeOperationId=isRecord(result)&&isRecord(result.task)?text(result.task.startOperationId):undefined;
      setDeliveries(previous=>previous.map(item=>item.operationId===operation.id?{...item,state:'accepted',files:undefined,runId:run?.id,nativeOperationId,runStatus:run?.status}:item));
      setAcceptedImageIds(files.map(file=>(file as typeof file&{id?:string}).id).filter((id):id is string=>Boolean(id)));
      if(draftState.current.text.trim()===value&&JSON.stringify(draftState.current.mentions)===JSON.stringify(mentions)){setDraft('');setDraftMentions([]);}
      await loadDetail(id);
    }catch(reason){
      if(current()){const status=(reason as {status?:number})?.status;setDeliveries(previous=>previous.map(item=>item.operationId===operation.id?{...item,state:status&&status>=400&&status<500?'rejected':'unknown',error:reason instanceof Error?reason.message:'Could not send message.',canRetry:!status||status===408||status===429||status>=500}:item));}
      const failure=new Error(reason instanceof Error?reason.message:'Could not send message.') as Error&{deliveryOperationId:string};failure.deliveryOperationId=operation.id;throw failure;
    }finally{if(current()){busyRef.current=false;setBusy(false);}}
  };
  const action=async(kind:'start'|'cancel')=>{
    if(!detail||busyRef.current)return;const id=detail.id,version=viewVersion.current;
    const current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    busyRef.current=true;setBusy(true);setError('');
    try{await props.request(`/v1/tasks/${encodeURIComponent(id)}/${kind}`,{method:'POST'});if(current()){await loadTasks();if(current())await loadDetail(id)}}
    catch(reason){if(current())setError(reason instanceof Error?reason.message:`Could not ${kind==='start'?'start':'cancel'} task.`)}
    finally{if(current()){busyRef.current=false;setBusy(false)}}
  };
  const decideApproval=async(approval:TaskApproval,decision:'approve'|'deny',allowComputer=false)=>{
    const id=selected;if(!id||busyRef.current||!detail||detail.id!==id||!['running','waiting_approval','waiting_connection'].includes(detail.status)||approval.status!=='pending'||approvalExpired(approval)||approvalError)return;
    const version=viewVersion.current,current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    busyRef.current=true;setBusy(true);setError('');
    try {
      if(allowComputer){const result=await request(`/v1/bots/${encodeURIComponent(detail.botId)}`,{method:'PATCH',body:{computerApprovalMode:'automatic'}});if(isRecord(result)&&isRecord(result.bot))propsRef.current.onBotUpdated?.(result.bot as unknown as Bot);}
      await props.request(`/v1/tasks/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approval.id)}`,{method:'POST',body:{decision}});
      if(current())await loadDetail(id);
    } catch(reason){if(current())setError(reason instanceof Error?reason.message:'Could not resolve task approval.');}
    finally{if(current()){busyRef.current=false;setBusy(false);}}
  };
  const botNames=new Map(props.bots.map(bot=>[bot.id,bot.name]));
  const visibleTasks=tasks.filter(task=>(filter==='all'||(filter==='active'?activeStatuses.has(task.status):task.status===filter))&&`${task.title} ${task.description||''} ${task.botName||botNames.get(task.botId)||''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const assigned=props.bots.find(bot=>bot.id===detail?.botId);
  const bot=useMemo<Bot>(()=>({instructions:'',runtime:'pi',model:'',createdAt:'',updatedAt:'',...assigned,id:detail?.botId||'',name:assigned?.name||detail?.botName||'Assigned bot'}),[assigned,detail?.botId,detail?.botName]);
  useLayoutEffect(()=>{if(avatarRef.current&&bot.id)propsRef.current.decorateAvatar?.(avatarRef.current,bot.id)},[bot.id,bot.model,bot.updatedAt,selected]);
  useEffect(()=>{if(!active){viewVersion.current++;busyRef.current=false;setBusy(false);setOlderBusy(false);setDeliveries(previous=>previous.map(item=>item.state==='sending'?{...item,state:'unknown',canRetry:true}:item));}},[active]);
  const artifactLoader=useCallback<ArtifactLoader>((botId,artifactId,signal)=>propsRef.current.loadArtifact?propsRef.current.loadArtifact(botId,artifactId,signal):Promise.reject(new Error('Task image unavailable.')),[]);
  const visibleMessageList=useMemo(()=>messages.slice(-visibleMessages),[messages,visibleMessages]);
  const currentRun=runs.filter(run=>!run.subagentId&&!['completed','failed','cancelled','interrupted'].includes(run.status)).at(-1)||null;
  const streamed=Object.entries(partials).find(([id,value])=>value&&!['completed','failed','cancelled','interrupted'].includes(knownRuns.current.get(id)?.status||''));
  const history=async()=>{
    if(messages.length>visibleMessages){setVisibleMessages(value=>Math.min(500,value+100));return;}
    if(messageCursorRef.current)await loadOlder('messages');
    if(eventCursorRef.current)await loadOlder('events');
  };
  const contextRequest:ChatCallbacks['onContextRequest']=async(_botId,path,options)=>{
    const id=selectedRef.current,version=viewVersion.current;if(!id)throw new Error('Choose a task first.');
    const result=await request(`/v1/tasks/${encodeURIComponent(id)}${path}`,options);
    if(selectedRef.current===id&&viewVersion.current===version&&mounted.current&&isRecord(result)){
      if(isRecord(result.context)&&Array.isArray(result.context.compactions))setCompactions(result.context.compactions as CompactionReceipt[]);
      if(isRecord(result.compaction)){const receipt=result.compaction as unknown as CompactionReceipt;setCompactions(previous=>[...previous.filter(item=>item.id!==receipt.id),receipt]);}
    }return result;
  };
  const connect=async(requestId:string)=>{
    const id=selectedRef.current,version=viewVersion.current;if(!id||connections.some(item=>item.id===requestId&&item.busy))return;
    const current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    let popup:Window|null=null;
    setConnections(previous=>previous.map(item=>item.id===requestId?{...item,busy:true,error:undefined}:item));
    try{
      popup=window.open('about:blank','_blank');if(!popup)throw new Error('Your browser blocked the new tab. Allow pop-ups for Timber and try again.');popup.opener=null;popup.document.title='Connecting GitHub';
      const result=await request(`/v1/tasks/${encodeURIComponent(id)}/connections/${encodeURIComponent(requestId)}/connect`,{method:'POST',body:{}});
      if(!current()){popup.close();return;}
      if(!isRecord(result)||typeof result.url!=='string')throw new Error('GitHub did not return a connection address.');
      const url=new URL(result.url,location.origin);if((url.origin!==location.origin&&(url.protocol!=='https:'||url.hostname!=='github.com'))||url.username||url.password)throw new Error('GitHub returned an invalid connection address.');
      if(popup.closed)throw new Error('The connection tab was closed. Select Connect GitHub to continue.');popup.location.replace(url.href);
      setConnections(previous=>previous.map(item=>item.id===requestId?{...item,opened:true}:item));
    }catch(reason){popup?.close();if(current())setConnections(previous=>previous.map(item=>item.id===requestId?{...item,error:reason instanceof Error?reason.message:'Could not connect GitHub.'}:item));}
    finally{if(current())setConnections(previous=>previous.map(item=>item.id===requestId?{...item,busy:false}:item));}
  };
  bridge.current={
    onDraft:(_botId,value,mentions)=>{const recipients=mentions??draftState.current.mentions;draftState.current={text:value,mentions:recipients};setDraft(value);setDraftMentions(recipients);},
    onSend:(_botId,value,mentions,files)=>send(value,mentions,files),
    onOpenBot:id=>propsRef.current.onOpenBot?.(id),onOpenTask:id=>selectTask(id),
    onOpenAgents:id=>{setSelectedAgent(id||null);setAgentsOpen(true);},
    onModelSettings:async(id,settings)=>{if(!propsRef.current.onModelSettings)throw new Error('Model settings are unavailable.');await propsRef.current.onModelSettings(id,settings);},
    onRefreshModels:()=>propsRef.current.onRefreshModels?.(),onContextRequest:contextRequest,
    onRecovery:(_botId,target)=>{if(target==='connection')propsRef.current.onOpenSettings?.();else document.querySelector<HTMLButtonElement>(`.timber-tasks-detail ${target==='model'?'.timber-model-trigger':'.timber-memory-trigger'}`)?.click();},
    onRetry:(_botId,operationId)=>{const delivery=deliveries.find(item=>item.operationId===operationId);if(delivery)void send(delivery.text,delivery.mentions,delivery.files,delivery.receipt).catch(()=>{});},
    onDecision:(_botId,id,decision,allowComputer)=>{const approval=approvals.find(item=>item.id===id);if(approval)void decideApproval(approval,decision,allowComputer);},
    onClearFilter:()=>{},onHistoryNearTop:()=>void history(),
    onStop:()=>void action('cancel'),onConnect:(_botId,id)=>void connect(id),
  };
  const callbacks=useMemo<ChatCallbacks>(()=>{
    const scope=selected,version=viewVersion.current;
    const current=()=>Boolean(scope&&selectedRef.current===scope&&viewVersion.current===version&&propsRef.current.active!==false);
    const call=()=>{if(!current())throw new Error('The conversation changed. Send from the current task.');return bridge.current!;};
    return {
      onDraft:(...args)=>{if(current())bridge.current!.onDraft(...args);},onSend:(...args)=>call().onSend(...args),
      onOpenBot:(...args)=>call().onOpenBot(...args),onOpenTask:(...args)=>call().onOpenTask?.(...args),onOpenAgents:(...args)=>call().onOpenAgents(...args),
      onModelSettings:(...args)=>call().onModelSettings(...args),onRefreshModels:()=>call().onRefreshModels(),onContextRequest:(...args)=>call().onContextRequest(...args),onRecovery:(...args)=>call().onRecovery(...args),
      onRetry:(...args)=>call().onRetry(...args),onDecision:(...args)=>call().onDecision(...args),onClearFilter:()=>call().onClearFilter(),onHistoryNearTop:(...args)=>call().onHistoryNearTop?.(...args),onStop:(...args)=>call().onStop(...args),onConnect:(...args)=>call().onConnect(...args),
    };
  },[selected,active,viewVersion.current]);
  const chatModel:ChatModel={bot,messages:visibleMessageList,runs,approvals:approvals.map(item=>({...item,status:item.status==='pending'&&approvalExpired(item)?'expired':item.status,busy:busy||Boolean(approvalError)})),connections,events,
    deliveries,draft,draftMentions,acceptedImageIds,mentionBots:props.bots as Bot[],subagents,delegations,collaborationEvents:events.filter(event=>event.type.startsWith('agent.')||event.type.startsWith('delegation.')),compactions,
    sending:busy,composerDisabled:!detail||['pending','cancelling','cancelled'].includes(detail.status),loading:loadingMessages,modelSettings:props.modelSettings||{choices:[],loading:false},
    currentRun,runFilter:null,focusApproval:0,stream:streamed?{runId:streamed[0],text:streamed[1]}:null,
    historyLoading:olderBusy,historyHasMore:Boolean(messageCursor||eventCursor||messages.length>visibleMessages),historyError:loadError||undefined,
  };
  const appLink=(event:MouseEvent<HTMLElement>)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
    const anchor=(event.target as Element).closest<HTMLAnchorElement>('a[href]');if(!anchor||!selected||!detail)return;
    let url:URL;try{url=new URL(anchor.href,location.origin);}catch{return;}
    const match=/^\/apps\/([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\/$/i.exec(url.pathname);
    if(!match||match[1]!==detail.botId||match[2]!==selected||url.search||url.hash)return;
    event.preventDefault();const popup=window.open('about:blank','_blank');if(!popup){setError('Allow a new tab to open this app.');return;}
    const id=selected;void(async()=>{
      try{
        const result=await request(`/v1/tasks/${encodeURIComponent(id)}/apps/${encodeURIComponent(match[3])}/open`,{method:'POST',body:{}});
        if(!isRecord(result)||typeof result.actionUrl!=='string'||typeof result.ticket!=='string')throw new Error('Could not open the task app.');
        const target=new URL(result.actionUrl);if(target.origin!==url.origin||target.pathname!==url.pathname+'__timber_open'||target.search||target.hash||target.username||target.password||popup.closed)throw new Error('Could not verify the task app.');
        const form=popup.document.createElement('form');form.method='POST';form.action=target.href;const input=popup.document.createElement('input');input.type='hidden';input.name='ticket';input.value=result.ticket;form.append(input);popup.document.body.append(form);popup.opener=null;form.submit();
      }catch{popup.close();if(selectedRef.current===id)setError('The task app could not be opened. Ask the task to check that it is running.');}
    })();
  };
  const detailContent=selected?<section className="timber-tasks-detail" data-task-id={selected} onClick={appLink}>
    <header className="bot-header">
      <button type="button" className="icon-button quiet timber-task-back" aria-label="Back to tasks" onClick={()=>selectTask(null)}><ArrowLeftIcon/></button>
      <span ref={avatarRef} className="avatar large" aria-hidden="true" title={bot.name}>{bot.name.slice(0,1)}</span>
      <div className="bot-identity"><h1 title={`${bot.name} · ${detail?.title||'Task'}`}>{detail?.title||'Task'}</h1></div>
      <span ref={setHeaderTarget}/><span className="spacer"/>
      {detail&&<span className="status timber-task-state" data-task-state data-status={detail.status} role="status">{statusName(detail.status)}</span>}
      {detail&&activeStatuses.has(detail.status)&&detail.status!=='cancelling'&&<button type="button" className="icon-button quiet timber-task-stop" disabled={busy} onClick={()=>void action('cancel')} aria-label="Cancel task" title="Cancel task"><SquareIcon/></button>}
      <Dialog.Root open={desktopOpen} onOpenChange={setDesktopOpen}><Dialog.Trigger asChild><button type="button" className="icon-button quiet" aria-label="Task computer" title="Task computer"><MonitorIcon/></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="timber-memory-overlay"/><Dialog.Content className="timber-memory-dialog timber-task-desktop-dialog"><div className="timber-secure-title"><Dialog.Title>Task computer</Dialog.Title><Dialog.Close asChild><button type="button" className="quiet icon-button" aria-label="Close task computer"><XIcon/></button></Dialog.Close></div><Dialog.Description className="sr-only">The computer used by this task.</Dialog.Description><TaskDesktop taskId={selected} request={request}/></Dialog.Content></Dialog.Portal></Dialog.Root>
      <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Dialog.Trigger asChild><button type="button" className="icon-button quiet" aria-label="Task details" title="Task details"><InfoIcon/></button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="timber-memory-overlay"/><Dialog.Content className="timber-memory-dialog timber-task-details-dialog">
          <div className="timber-secure-title"><Dialog.Title>Task details</Dialog.Title><Dialog.Close asChild><button type="button" className="quiet icon-button" aria-label="Close task details"><XIcon/></button></Dialog.Close></div>
          <h3>{detail?.title||'Task'}</h3><Dialog.Description>{detail?.description||'No description.'}</Dialog.Description>
          <dl><dt>Bot</dt><dd>{bot.name}</dd><dt>Status</dt><dd>{detail?statusName(detail.status):'Loading…'}</dd>{detail?.computerMode&&<><dt>Computer</dt><dd>{detail.computerMode==='isolated'?'This task':'Shared with bot'}</dd></>}{detail?.createdAt&&<><dt>Created</dt><dd>{date(detail.createdAt)}</dd></>}</dl>
          {detail?.status==='cancelled'&&<p className="hint">Cancelled tasks stay stopped. Create a new task to work again.</p>}
          <div className="dialog-actions"><button type="button" className="quiet" onClick={refresh} aria-label="Refresh task"><RefreshCwIcon/>Refresh</button>{detail?.botId&&props.onOpenBot&&<button type="button" className="quiet" onClick={()=>props.onOpenBot?.(detail.botId)}>Open bot</button>}
            {archivedActivity&&<button type="button" className="quiet" onClick={()=>{latestActivity();setDetailsOpen(false);}}>Latest activity</button>}
            {detail?.status==='pending'&&<button type="button" disabled={busy} onClick={()=>void action('start')}><ArrowUpIcon/>Start task</button>}
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </header>
    <Dialog.Root open={agentsOpen} onOpenChange={setAgentsOpen}><Dialog.Portal><Dialog.Overlay className="timber-memory-overlay"/><Dialog.Content className="timber-memory-dialog timber-task-agents-dialog">
      <div className="timber-secure-title"><Dialog.Title>Agents</Dialog.Title><Dialog.Close asChild><button type="button" className="quiet icon-button" aria-label="Close task agents"><XIcon/></button></Dialog.Close></div><Dialog.Description className="sr-only">Agents working in this task conversation.</Dialog.Description>
      <Agents model={{botId:bot.id,botName:bot.name,botModel:bot.model,agents:subagents,namedAgents:props.bots.filter(item=>item.createdByBotId===bot.id) as Bot[],delegations,loading:loadingMessages,selectedAgentId:selectedAgent,revision:events.at(-1)?.id||0,events,runs,collaborationEvents:chatModel.collaborationEvents}} callbacks={{request:callbacks.onContextRequest,onSelect:setSelectedAgent,onRefresh:()=>{if(selected)void loadDetail(selected)},onOpenBot:callbacks.onOpenBot}}/>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    {(error||approvalError)&&<p className="error notice" role="alert">{error||approvalError}</p>}
    {detail?.status==='queued'&&<div className="timber-task-queue" role="status"><span>{queueName(detail)}</span>{detail.queue?.blockingTask&&<button type="button" className="timber-tasks-link" onClick={()=>selectTask(detail.queue!.blockingTask!.id)}>Open task</button>}</div>}
    <div className="timber-chat"><ConversationChat key={selected} model={chatModel} callbacks={callbacks} loadArtifact={artifactLoader} headerTarget={headerTarget}/></div>
  </section>:null;
  const overviewContent=<section className="timber-tasks-overview" role={!selected&&!wide?'region':undefined} aria-label={!selected&&!wide?'Global tasks':undefined}>
    <header className="section-title sidebar-heading timber-tasks-overview-heading"><h2>Tasks <span className="counter">{tasks.length}</span></h2><div className="row">
      <button type="button" className="icon-button quiet" onClick={refresh} aria-label="Refresh tasks" title="Refresh tasks"><RefreshCwIcon/></button><button type="button" className="new-bot icon-button" aria-label={showCreate?'Close create task':'New task'} title="New task" onClick={()=>{setShowCreate(value=>!value);setError('')}}><PlusIcon/></button></div></header>
    <div className="search-field timber-tasks-search"><SearchIcon aria-hidden="true"/><input className="search" aria-label="Search tasks" type="search" placeholder="Search tasks" value={search} onChange={event=>setSearch(event.currentTarget.value)}/><Popover.Root open={filtersOpen&&active} onOpenChange={setFiltersOpen}><Popover.Trigger asChild><button type="button" className="icon-button quiet timber-tasks-filter-trigger" aria-label="Filter tasks" title={filter==='all'?'Filter tasks':`Filter tasks: ${filter}`} data-filtered={filter!=='all'}><ListFilterIcon/></button></Popover.Trigger><Popover.Portal><Popover.Content className="timber-tasks-filter-popover" align="end" sideOffset={8} collisionPadding={12} aria-label="Task filters"><div className="timber-tasks-filters" role="group" aria-label="Filter tasks by status">{(['all','active','pending','completed'] as TaskFilter[]).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setFiltersOpen(false)}}>{value==='all'?'All':value==='active'?'Active':statusName(value)}</button>)}</div></Popover.Content></Popover.Portal></Popover.Root></div>
    {showCreate&&<form className="timber-tasks-create" onSubmit={event=>void create(event)}><h3>Create a task</h3><label>Title<input autoFocus required maxLength={160} value={title} onChange={event=>setTitle(event.currentTarget.value)} placeholder="What needs to be done?"/></label><label>Description<textarea rows={3} maxLength={32000} value={description} onChange={event=>setDescription(event.currentTarget.value)} placeholder="Add context or instructions (optional)"/></label><label>Assigned bot<select required value={botId} onChange={event=>setBotId(event.currentTarget.value)}><option value="" disabled>Select a bot</option>{props.bots.map(bot=><option value={bot.id} key={bot.id}>{bot.name}</option>)}</select></label><label className="timber-tasks-checkbox"><input type="checkbox" checked={startImmediately} onChange={event=>setStartImmediately(event.currentTarget.checked)}/>Start immediately</label>{error&&<p className="timber-tasks-error" role="alert">{error}</p>}<div className="timber-tasks-form-actions"><button type="button" className="timber-tasks-quiet" onClick={()=>setShowCreate(false)}>Cancel</button><button type="submit" className="timber-tasks-action" disabled={creating||!props.bots.length||!title.trim()}>{creating&&<LoaderCircleIcon className="timber-tasks-spinner"/>}{creating?'Creating…':'Create task'}</button></div>{!props.bots.length&&<p className="timber-tasks-hint">Create a bot before assigning a task.</p>}</form>}
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError} <button type="button" className="timber-tasks-link" onClick={refresh}>Retry</button></p>}
    {!tasks.length&&<div className="timber-tasks-empty">{loading?<><LoaderCircleIcon className="timber-tasks-spinner"/><span>Loading tasks…</span></>:<><strong>No tasks yet</strong><span>Create a global task and assign it to a bot. Its conversation stays separate from bot chat.</span></>}</div>}
    {!!tasks.length&&!visibleTasks.length&&<div className="timber-tasks-empty"><strong>No {filter} tasks</strong><span>Choose another filter to see other tasks.</span></div>}
    {!!visibleTasks.length&&<div className="timber-tasks-list bot-list">{visibleTasks.map(task=>{const assignedBot=props.bots.find(bot=>bot.id===task.botId),model=assignedBot?.model,modelName=props.modelSettings?.choices.find(choice=>choice.id===model)?.label||model;return <button type="button" className={`timber-tasks-card bot-item${selected===task.id?' selected':''}`} aria-pressed={selected===task.id} key={task.id} data-task-id={task.id} onClick={()=>selectTask(task.id)}><TaskAvatar bot={assignedBot} decorate={props.decorateAvatar}/><span className="bot-info"><span className="bot-name-line"><span className="bot-name">{task.title}</span>{modelName&&<span className="bot-model-badge" data-model={model} title={model}>{modelName}</span>}</span><span className="bot-preview-line"><small className="bot-preview">{(task.status==='queued'?queueName(task):(task.description||'Start a conversation')).replace(/\[private:[a-f0-9-]{36}\]/gi,'🔒 ••••••').replace(/\s+/g,' ').trim()}</small><span className="bot-activity-status" data-status={task.status}>{statusName(task.status)}</span></span></span></button>})}</div>}
  </section>;
  const sidebar=props.listContainer&&active?props.listContainer:null;
  if(!active)return null;
  return <div className="timber-tasks" role={selected||wide?'region':undefined} aria-label={selected||wide?'Global tasks':undefined}>{sidebar?createPortal(overviewContent,sidebar):null}{detailContent||(!sidebar?overviewContent:<div className="timber-tasks-empty timber-tasks-choose"><CheckSquareIcon aria-hidden="true"/><h2>Choose a task</h2><span>Its conversation and activity stay here.</span></div>)}</div>;
}

export function mountTasks(container:HTMLElement,props:TasksProps) {
  const root=createRoot(container);
  root.render(createElement(TaskView,{props}));
  return {update(next:TasksProps){root.render(createElement(TaskView,{props:next}))},unmount(){root.unmount()}};
}
