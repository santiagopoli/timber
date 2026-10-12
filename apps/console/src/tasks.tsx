import {createElement, memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {ArrowLeftIcon, ArrowUpIcon, CheckSquareIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, SearchIcon, SquareIcon} from 'lucide-react';
import {MessageResponse} from './components/ai-elements/message';
import type {Bot, BotEvent, Message, Run} from '../../../packages/contracts/src/index';
import {ActivityPanel} from './chat';
import {ArtifactProvider,type ArtifactLoader} from './artifact-preview';
import {useConversationScroll} from './use-conversation-scroll';
import type {ReactNode} from 'react';
import './tasks.css';

type RequestOptions = {method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean};
export type TasksRequest = (path: string, options?: RequestOptions) => Promise<unknown>;
export type TasksBot = {id: string; name: string};
export type TasksProps = {
  request: TasksRequest;
  bots: TasksBot[];
  onClose?: () => void;
  onOpenBot?: (botId: string) => void;
  selectedTaskId?: string|null;
  active?: boolean;
  onSelectTask?: (taskId:string|null) => void;
  loadArtifact?: ArtifactLoader;
  listContainer?: HTMLElement;
};
type TaskStatus = 'pending'|'queued'|'running'|'waiting_approval'|'waiting_connection'|'cancelling'|'completed'|'failed'|'cancelled'|string;
type Task = {id:string;title:string;description?:string;botId:string;botName?:string;status:TaskStatus;createdAt?:string;updatedAt?:string;lastActivity?:string};
type TaskFilter = 'all'|'active'|'pending'|'completed';
type TaskApproval = {id:string;status:string;action:Record<string,unknown>;expiresAt:string};
type TaskMessage = {id?:string;role?:string;text?:string;content?:string;createdAt?:string};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown) => typeof value === 'string' ? value : '';
const label = (value: string) => value.replaceAll('_',' ');
const date = (value?: string) => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const activeStatuses = new Set(['queued','running','waiting_approval','waiting_connection','cancelling']);
const statusName = (status: string) => (({pending:'Pending',queued:'Queued',running:'Running',waiting_approval:'Needs approval',waiting_connection:'Needs connection',cancelling:'Cancelling',completed:'Completed',failed:'Failed',cancelled:'Cancelled'} as Record<string,string>)[status] || label(status));
function taskList(value: unknown): Task[] {
  const source = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.tasks) ? value.tasks : [];
  return source.filter(isRecord).map(item => ({id:text(item.id),title:text(item.title)||'Untitled task',description:text(item.description),botId:text(item.botId),botName:text(item.botName),status:text(item.status)||'pending',createdAt:text(item.createdAt),updatedAt:text(item.updatedAt),lastActivity:text(item.lastActivity)})).filter(item=>item.id);
}
function taskDetail(value: unknown): Task | undefined {
  const candidate = isRecord(value) && isRecord(value.task) ? value.task : value;
  return taskList([candidate])[0];
}
function messageList(value: unknown): TaskMessage[] {
  const source = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  return source.filter(isRecord).map(item=>({id:text(item.id),role:text(item.role)||'assistant',text:text(item.text)||text(item.content),createdAt:text(item.createdAt)}));
}
function mergeMessages(previous:TaskMessage[],incoming:TaskMessage[],older=false){
  const known=new Set(previous.map(message=>message.id));
  const added=incoming.filter(message=>!message.id||!known.has(message.id));
  if(!added.length)return previous;
  return (older?[...added,...previous]:[...previous,...added]).slice(older?0:-500,older?500:undefined);
}
function approvalList(value: unknown): TaskApproval[] {
  const source = isRecord(value) && Array.isArray(value.approvals) ? value.approvals : [];
  return source.filter(isRecord).map(item=>({id:text(item.id),status:text(item.status),action:isRecord(item.action)?item.action:{},expiresAt:text(item.expiresAt)})).filter(item=>item.id);
}
const approvalExpired = (approval:TaskApproval) => Boolean(approval.expiresAt && Date.parse(approval.expiresAt)<=Date.now());
const TaskMessageRow=memo(function TaskMessageRow({message,name}:{message:TaskMessage;name:string}){
  return <article className={`timber-task-message timber-task-message-${message.role}`} data-task-message-id={message.id} data-timeline-key={`message:${message.id}`}>
    <div className="timber-task-message-meta"><strong>{message.role==='user'?'You':message.role==='assistant'?name:label(message.role||'message')}</strong>{message.createdAt&&<time>{date(message.createdAt)}</time>}</div>
    <MessageResponse className="timber-task-markdown" mode="static" skipHtml plugins={{}} components={{img:()=>null}} linkSafety={{enabled:false}} controls={false}>{message.text||''}</MessageResponse>
  </article>;
});
function TaskConversation({children}:{children:ReactNode}){
  const scroll=useConversationScroll();
  return <div className="timber-tasks-messages" aria-label="Task conversation" aria-live="polite"><div className="timber-task-scroll" data-task-scroll ref={scroll.scrollRef}><div className="timber-task-conversation-content" ref={scroll.contentRef}>{children}</div></div></div>;
}

function TaskView({props}:{props:TasksProps}) {
  const [wide,setWide]=useState(()=>matchMedia('(min-width:761px)').matches);
  useEffect(()=>{const query=matchMedia('(min-width:761px)'),update=()=>setWide(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[]);
  const [tasks,setTasks]=useState<Task[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Task|null>(null),[messages,setMessages]=useState<TaskMessage[]>([]);
  const [loading,setLoading]=useState(true),[loadingMessages,setLoadingMessages]=useState(false),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState(''),[showCreate,setShowCreate]=useState(false),[filter,setFilter]=useState<TaskFilter>('all');
  const [approvals,setApprovals]=useState<TaskApproval[]>([]),[approvalError,setApprovalError]=useState('');
  const [search,setSearch]=useState(''),[events,setEvents]=useState<BotEvent[]>([]),[runs,setRuns]=useState<Run[]>([]),[activityOpen,setActivityOpen]=useState(true);
  const [partials,setPartials]=useState<Record<string,string>>({}),partialRef=useRef<Record<string,string>>({}),knownRuns=useRef(new Map<string,Run>());
  const [messageCursor,setMessageCursor]=useState<string|null>(null),[eventCursor,setEventCursor]=useState<string|null>(null),[olderBusy,setOlderBusy]=useState(false),[visibleMessages,setVisibleMessages]=useState(100),[archivedActivity,setArchivedActivity]=useState(false);
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[botId,setBotId]=useState(props.bots[0]?.id||''),[startImmediately,setStartImmediately]=useState(true),[draft,setDraft]=useState('');
  const createOperation=useRef<{key:string;id:string}|null>(null),sendOperation=useRef<{key:string;id:string}|null>(null),mounted=useRef(true);
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
    // Fence the old view synchronously, including switching away and back to the same task.
    viewVersion.current++;selectedRef.current=id;listRead.current?.abort();detailRead.current?.abort();olderRead.current?.abort();setSelected(id);
    setDetail(null);setMessages([]);setApprovals([]);setEvents([]);setRuns([]);knownRuns.current.clear();partialRef.current={};setPartials({});setMessageCursor(null);setEventCursor(null);streamCursor.current=0;olderMessagesLoaded.current=false;setVisibleMessages(100);setOlderBusy(false);setArchivedActivity(false);setDraft('');setBusy(false);setError('');setLoadError('');setApprovalError('');
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
      const [taskResult,messageResult,approvalResult,runResult,eventResult]=await Promise.all([
        request(path,options),request(`${path}/messages?limit=100`,options),
        request(`${path}/approvals`,options).then(value=>({value,error:''}),reason=>({value:null,error:reason instanceof Error?reason.message:'Could not load task approvals.'})),
        request(`${path}/runs?limit=100`,options),streamCursor.current?Promise.resolve(null):request(`${path}/events?format=json&view=activity&limit=100`,options),
      ]);
      if(!current())return;
      setDetail(taskDetail(taskResult)||tasksRef.current.find(item=>item.id===id)||null);setMessages(previous=>mergeMessages(previous,messageList(messageResult)));setLoadError('');
      if(isRecord(messageResult)&&!olderMessagesLoaded.current)setMessageCursor(text(messageResult.nextCursor)||null);
      if(isRecord(runResult)&&Array.isArray(runResult.runs)){const incoming=runResult.runs as Run[];knownRuns.current=new Map(incoming.map(run=>[run.id,run]));setRuns(incoming)}
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
      const batch=pending;pending=[];if(archiveRef.current)return;
      setEvents(previous=>{const seen=new Set(previous.map(event=>event.id));const merged=[...previous,...batch.filter(event=>!seen.has(event.id))];if(merged.length>200)setEventCursor(String(merged[merged.length-200]!.id));return merged.slice(-200)});
    };
    const record=(event:BotEvent)=>{
      const data=event.data;
      if(event.type==='stream.snapshot'&&Number.isSafeInteger(data.latestEventId)&&Number(data.latestEventId)>=streamCursor.current){
        streamCursor.current=Number(data.latestEventId);partialRef.current={};
        if(Array.isArray(data.partials))for(const partial of data.partials.slice(0,16))if(isRecord(partial)&&typeof partial.runId==='string'&&typeof partial.text==='string'&&!['completed','failed','cancelled','interrupted'].includes(knownRuns.current.get(partial.runId)?.status||''))partialRef.current[partial.runId]=partial.text.slice(-65_536);
        partialChanged=true;
      }else{
        if(!Number.isSafeInteger(event.id)||Number(event.id)<=streamCursor.current)return;streamCursor.current=Number(event.id);
        if(['tool.started','tool.completed','process.updated','run.failed','run.cancellation.requested','subagent.tool.started','subagent.tool.completed'].includes(event.type)){pending.push(event);if(pending.length>200)pending=pending.slice(-200)}
        if(event.type==='message.created'&&isRecord(data.message)&&typeof data.message.id==='string'&&typeof data.message.text==='string'&&['user','assistant','tool','system'].includes(String(data.message.role))){pendingMessages.push(...messageList([data.message]));if(pendingMessages.length>200)pendingMessages=pendingMessages.slice(-200);if(data.message.role==='assistant'&&event.runId){delete partialRef.current[event.runId];partialChanged=true}}
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
      else if(Array.isArray(result.events)){archiveRef.current=true;setArchivedActivity(true);setEvents(result.events as BotEvent[]);setEventCursor(next)}
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
  const send=async(event:FormEvent)=>{
    event.preventDefault();const value=draft.trim(),id=selected;if(!id||!value||busy)return;
    // A failed send can be retried, but never reuse its identity in another task.
    const key=JSON.stringify([id,value]),operation=sendOperation.current?.key===key?sendOperation.current:{key,id:crypto.randomUUID()};sendOperation.current=operation;
    const version=viewVersion.current,current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    setBusy(true);setError('');
    try {
      await props.request(`/v1/tasks/${encodeURIComponent(id)}/${detail&&['completed','failed'].includes(detail.status)?'continue':'messages'}`,{method:'POST',body:{operationId:operation.id,text:value}});
      if(sendOperation.current===operation)sendOperation.current=null;
      if(!current())return;setDraft('');await loadDetail(id);
    }
    catch(reason){if(current())setError(reason instanceof Error?reason.message:'Could not send message.');}
    finally{if(current())setBusy(false);}
  };
  const action=async(kind:'start'|'cancel')=>{
    if(!detail||busy)return;const id=detail.id,version=viewVersion.current;
    const current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    setBusy(true);setError('');
    try{await props.request(`/v1/tasks/${encodeURIComponent(id)}/${kind}`,{method:'POST'});if(current()){await loadTasks();if(current())await loadDetail(id)}}
    catch(reason){if(current())setError(reason instanceof Error?reason.message:`Could not ${kind==='start'?'start':'cancel'} task.`)}
    finally{if(current())setBusy(false)}
  };
  const decideApproval=async(approval:TaskApproval,decision:'approve'|'deny')=>{
    const id=selected;if(!id||busy||!detail||detail.id!==id||!['running','waiting_approval','waiting_connection'].includes(detail.status)||approval.status!=='pending'||approvalExpired(approval)||approvalError)return;
    const version=viewVersion.current,current=()=>mounted.current&&selectedRef.current===id&&viewVersion.current===version;
    setBusy(true);setError('');
    try {
      await props.request(`/v1/tasks/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approval.id)}`,{method:'POST',body:{decision}});
      if(current())await loadDetail(id);
    } catch(reason){if(current())setError(reason instanceof Error?reason.message:'Could not resolve task approval.');}
    finally{if(current())setBusy(false);}
  };
  const botNames=new Map(props.bots.map(bot=>[bot.id,bot.name]));
  const visibleTasks=tasks.filter(task=>(filter==='all'||(filter==='active'?activeStatuses.has(task.status):task.status===filter))&&`${task.title} ${task.description||''} ${task.botName||botNames.get(task.botId)||''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const activityModel=useMemo(()=>({bot:(props.bots.find(bot=>bot.id===detail?.botId)||{id:detail?.botId||'',name:detail?.botName||'Assigned bot'}) as Bot,events,runs,approvals:[],runFilter:null,subagents:[],delegations:[],mentionBots:[],messages:messages as Message[],collaborationEvents:[]}),[props.bots,detail?.botId,detail?.botName,events,runs,messages]);
  const activityCallbacks=useMemo(()=>({onOpenBot:(id:string)=>propsRef.current.onOpenBot?.(id),onOpenAgents:()=>{}}),[]);
  const artifactLoader=useCallback<ArtifactLoader>((botId,artifactId,signal)=>propsRef.current.loadArtifact?propsRef.current.loadArtifact(botId,artifactId,signal):Promise.reject(new Error('Task image unavailable.')),[]);
  const canDecideApproval=Boolean(detail&&['running','waiting_approval','waiting_connection'].includes(detail.status));
  const waitingApprovals=approvals.filter(approval=>['pending','approved','executing'].includes(approval.status));
  const detailContent=selected ? <section className="timber-tasks-detail" data-task-id={selected}>
    <header className="timber-tasks-detail-heading"><button type="button" className="timber-tasks-icon-button" aria-label="Back to tasks" onClick={()=>selectTask(null)}><ArrowLeftIcon/></button><div className="timber-tasks-title-block"><h2>{detail?.title||'Task'}</h2><span className="timber-tasks-subtitle">{detail?.botName||botNames.get(detail?.botId||'')||'Assigned bot'}{detail?.status&&<> · <span className="timber-task-status" data-status={detail.status}>{statusName(detail.status)}</span></>}</span></div><button type="button" className="timber-tasks-quiet" onClick={refresh} aria-label="Refresh task"><RefreshCwIcon/></button>{detail?.botId&&props.onOpenBot&&<button type="button" className="timber-tasks-quiet" onClick={()=>props.onOpenBot?.(detail.botId)}>Open bot</button>}</header>
    {detail?.description&&<p className="timber-tasks-description">{detail.description}</p>}
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError}</p>}
    {approvalError&&<p className="timber-tasks-error" role="alert">{approvalError}</p>}
    {(waitingApprovals.length>0||detail?.status==='waiting_approval')&&<section className="timber-tasks-approvals" aria-label="Task approvals"><h3>Task approvals</h3>
      {!waitingApprovals.length&&<p className="timber-tasks-hint">{approvalError?'Approvals could not be loaded. Refresh this task to try again.':'Waiting for an approval request. Refresh this task to check its current state.'}</p>}
      {waitingApprovals.map(approval=><article className="timber-tasks-approval" data-task-approval-id={approval.id} key={approval.id}>
        <div className="timber-tasks-card-heading"><strong>{label(text(approval.action.type)||'Computer action')}</strong><span className="timber-task-status">{approvalExpired(approval)&&approval.status==='pending'?'Expired':statusName(approval.status)}</span></div>
        <details><summary>Review action</summary><pre>{JSON.stringify(approval.action,null,2)}</pre></details>
        {approval.expiresAt&&<p className="timber-tasks-hint">Expires {date(approval.expiresAt)}</p>}
        {approval.status==='pending'&&!approvalExpired(approval)&&<div className="timber-tasks-approval-actions"><button type="button" className="timber-tasks-action is-secondary" disabled={busy||Boolean(approvalError)||!canDecideApproval} onClick={()=>void decideApproval(approval,'deny')}>Deny</button><button type="button" className="timber-tasks-action" disabled={busy||Boolean(approvalError)||!canDecideApproval} onClick={()=>void decideApproval(approval,'approve')}>Approve</button></div>}
        {['approved','executing'].includes(approval.status)&&<p className="timber-tasks-hint">Decision recorded. Waiting for the action outcome.</p>}
      </article>)}
    </section>}
    <TaskConversation key={selected}>
      {(messageCursor||messages.length>visibleMessages)&&<button type="button" className="timber-tasks-quiet timber-task-history" disabled={olderBusy} onClick={()=>messages.length>visibleMessages?setVisibleMessages(value=>Math.min(500,value+100)):void loadOlder('messages')}>{olderBusy?'Loading…':'Load older messages'}</button>}
      {(loadingMessages&&!messages.length)&&<p className="timber-tasks-hint">Loading task conversation…</p>}
      {!loadingMessages&&!messages.length&&<p className="timber-tasks-hint">No messages in this task yet.</p>}
      {messages.slice(-visibleMessages).map((message,index)=><TaskMessageRow message={message} name={detail?.botName||botNames.get(detail?.botId||'')||'Assigned bot'} key={message.id||index}/>)}
      {Object.entries(partials).filter(([,value])=>value).map(([id,value])=><article className="timber-task-message timber-task-message-assistant" data-task-stream-run-id={id} data-timeline-key={`stream:${id}`} key={`stream:${id}`}><MessageResponse className="timber-task-markdown" mode="streaming" skipHtml plugins={{}} components={{img:()=>null}} linkSafety={{enabled:false}} controls={false}>{value}</MessageResponse></article>)}
    </TaskConversation>
    <section className="timber-tasks-activity" aria-label="Task activity"><div className="timber-task-activity-heading"><button type="button" className="timber-tasks-quiet" aria-expanded={activityOpen} onClick={()=>setActivityOpen(value=>!value)}>Activity {events.filter(event=>event.type==='tool.started').length>0&&<span className="counter">{events.filter(event=>event.type==='tool.started').length}</span>}</button>{archivedActivity&&<button type="button" className="timber-tasks-quiet" onClick={latestActivity}>Latest activity</button>}{eventCursor&&<button type="button" className="timber-tasks-quiet" disabled={olderBusy} onClick={()=>void loadOlder('events')}>{olderBusy?'Loading…':'Older activity'}</button>}</div>{activityOpen&&<div className="timber-task-activity-content">{events.length?<ArtifactProvider load={artifactLoader}><ActivityPanel model={activityModel} callbacks={activityCallbacks}/></ArtifactProvider>:<p className="timber-tasks-hint">Commands and tool activity appear here as this task works.</p>}</div>}</section>
    {error&&<p className="timber-tasks-error" role="alert">{error}</p>}
    <div className="timber-tasks-controls">
      {detail?.status==='pending'&&<button type="button" className="timber-tasks-action" disabled={busy} onClick={()=>void action('start')}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<ArrowUpIcon/>}{busy?'Starting…':'Start task'}</button>}
      {detail&&activeStatuses.has(detail.status)&&detail.status!=='cancelling'&&<button type="button" className="timber-tasks-action is-secondary" disabled={busy} onClick={()=>void action('cancel')}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<SquareIcon/>}{busy?'Working…':'Cancel task'}</button>}
      {detail?.status&&['completed','failed','cancelled'].includes(detail.status)&&<span className="timber-tasks-hint">This task is {statusName(detail.status).toLowerCase()}.</span>}
    </div>
    {detail&&['completed','failed'].includes(detail.status)&&<p className="timber-tasks-hint">Continue with new instructions below. This starts a new run in this task, without replaying old actions.</p>}
    {detail?.status==='cancelled'&&<p className="timber-tasks-hint">Cancelled tasks stay stopped. Create a new task to work again.</p>}
    {detail&&['running','waiting_approval','waiting_connection','completed','failed'].includes(detail.status)&&<form className="timber-tasks-composer" onSubmit={event=>void send(event)}><label className="timber-tasks-sr-only" htmlFor="timber-task-draft">Message this task</label><textarea id="timber-task-draft" rows={2} value={draft} onChange={event=>setDraft(event.currentTarget.value)} placeholder={['completed','failed'].includes(detail.status)?'New instructions to continue this task…':'Message this task…'}/><button type="submit" aria-label={['completed','failed'].includes(detail.status)?'Continue task':'Send task message'} disabled={busy||!draft.trim()}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:['completed','failed'].includes(detail.status)?'Continue':<ArrowUpIcon/>}</button></form>}
  </section> : null;
  const overviewContent=<section className="timber-tasks-overview">
    <header className="timber-tasks-overview-heading"><h2>Tasks <span className="counter">{tasks.length}</span></h2><div className="row"><button type="button" className="timber-tasks-icon-button" onClick={refresh} aria-label="Refresh tasks"><RefreshCwIcon/></button><button type="button" className="timber-tasks-icon-button new-bot" aria-label={showCreate?'Close create task':'New task'} onClick={()=>{setShowCreate(value=>!value);setError('')}}><PlusIcon/></button></div></header>
    <label className="search-field timber-tasks-search"><SearchIcon/><span className="timber-tasks-sr-only">Search tasks</span><input className="search" type="search" placeholder="Search tasks" value={search} onChange={event=>setSearch(event.currentTarget.value)}/></label>
    {showCreate&&<form className="timber-tasks-create" onSubmit={event=>void create(event)}><h3>Create a task</h3><label>Title<input autoFocus required maxLength={160} value={title} onChange={event=>setTitle(event.currentTarget.value)} placeholder="What needs to be done?"/></label><label>Description<textarea rows={3} maxLength={32000} value={description} onChange={event=>setDescription(event.currentTarget.value)} placeholder="Add context or instructions (optional)"/></label><label>Assigned bot<select required value={botId} onChange={event=>setBotId(event.currentTarget.value)}><option value="" disabled>Select a bot</option>{props.bots.map(bot=><option value={bot.id} key={bot.id}>{bot.name}</option>)}</select></label><label className="timber-tasks-checkbox"><input type="checkbox" checked={startImmediately} onChange={event=>setStartImmediately(event.currentTarget.checked)}/>Start immediately</label>{error&&<p className="timber-tasks-error" role="alert">{error}</p>}<div className="timber-tasks-form-actions"><button type="button" className="timber-tasks-quiet" onClick={()=>setShowCreate(false)}>Cancel</button><button type="submit" className="timber-tasks-action" disabled={creating||!props.bots.length||!title.trim()}>{creating&&<LoaderCircleIcon className="timber-tasks-spinner"/>}{creating?'Creating…':'Create task'}</button></div>{!props.bots.length&&<p className="timber-tasks-hint">Create a bot before assigning a task.</p>}</form>}
    <div className="timber-tasks-filters" role="group" aria-label="Filter tasks by status">{(['all','active','pending','completed'] as TaskFilter[]).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==='all'?'All':value==='active'?'Active':statusName(value)}</button>)}</div>
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError} <button type="button" className="timber-tasks-link" onClick={refresh}>Retry</button></p>}
    {!tasks.length&&<div className="timber-tasks-empty">{loading?<><LoaderCircleIcon className="timber-tasks-spinner"/><span>Loading tasks…</span></>:<><strong>No tasks yet</strong><span>Create a global task and assign it to a bot. Its conversation stays separate from bot chat.</span></>}</div>}
    {!!tasks.length&&!visibleTasks.length&&<div className="timber-tasks-empty"><strong>No {filter} tasks</strong><span>Choose another filter to see other tasks.</span></div>}
    {!!visibleTasks.length&&<div className="timber-tasks-list bot-list">{visibleTasks.map(task=><button type="button" className={`timber-tasks-card bot-item${selected===task.id?' selected':''}`} aria-pressed={selected===task.id} key={task.id} data-task-id={task.id} onClick={()=>selectTask(task.id)}><span className="avatar timber-task-avatar" aria-hidden="true"><CheckSquareIcon/></span><span className="bot-info"><span className="bot-name-line"><span className="bot-name">{task.title}</span><span className="timber-task-status" data-status={task.status}>{statusName(task.status)}</span></span><span className="bot-preview-line"><small className="bot-preview">{task.description||'No description'}</small></span><small className="timber-task-assignee">{task.botName||botNames.get(task.botId)||'Assigned bot'}{date(task.lastActivity||task.updatedAt||task.createdAt)&&<> · {date(task.lastActivity||task.updatedAt||task.createdAt)}</>}</small></span></button>)}</div>}
  </section>;
  const sidebar=wide&&props.listContainer&&active?props.listContainer:null;
  if(!active)return null;
  return <div className="timber-tasks" role="region" aria-label="Global tasks">{sidebar?createPortal(overviewContent,sidebar):!selected&&<div className="timber-tasks-topbar">{props.onClose&&<nav className="timber-view-toggle" aria-label="Main view"><button type="button" aria-pressed="false" onClick={props.onClose}>Bots</button><button type="button" aria-pressed="true" onClick={()=>selectTask(null)}>Tasks</button></nav>}</div>}{detailContent||(!sidebar?overviewContent:<div className="timber-tasks-empty timber-tasks-choose"><CheckSquareIcon aria-hidden="true"/><h2>Choose a task</h2><span>Its conversation and activity stay here.</span></div>)}</div>;
}

export function mountTasks(container:HTMLElement,props:TasksProps) {
  const root=createRoot(container);
  root.render(createElement(TaskView,{props}));
  return {update(next:TasksProps){root.render(createElement(TaskView,{props:next}))},unmount(){root.unmount()}};
}
