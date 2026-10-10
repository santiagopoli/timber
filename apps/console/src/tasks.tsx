import {createElement, useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeftIcon, ArrowUpIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, SquareIcon} from 'lucide-react';
import {MessageResponse} from './components/ai-elements/message';
import './tasks.css';

type RequestOptions = {method?: string; body?: unknown; signal?: AbortSignal};
export type TasksRequest = (path: string, options?: RequestOptions) => Promise<unknown>;
export type TasksBot = {id: string; name: string};
export type TasksProps = {
  request: TasksRequest;
  bots: TasksBot[];
  onClose?: () => void;
  onOpenBot?: (botId: string) => void;
};
type TaskStatus = 'pending'|'queued'|'running'|'waiting_approval'|'waiting_connection'|'completed'|'failed'|'cancelled'|string;
type Task = {id:string;title:string;description?:string;botId:string;botName?:string;status:TaskStatus;createdAt?:string;updatedAt?:string;lastActivity?:string};
type TaskMessage = {id?:string;role?:string;text?:string;content?:string;createdAt?:string};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown) => typeof value === 'string' ? value : '';
const label = (value: string) => value.replaceAll('_',' ');
const date = (value?: string) => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const activeStatuses = new Set(['queued','running','waiting_approval','waiting_connection']);
const statusName = (status: string) => (({pending:'Pending',queued:'Queued',running:'Running',waiting_approval:'Needs approval',waiting_connection:'Needs connection',completed:'Completed',failed:'Failed',cancelled:'Cancelled'} as Record<string,string>)[status] || label(status));
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
function TaskView({props}:{props:TasksProps}) {
  const [tasks,setTasks]=useState<Task[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Task|null>(null),[messages,setMessages]=useState<TaskMessage[]>([]);
  const [loading,setLoading]=useState(true),[loadingMessages,setLoadingMessages]=useState(false),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState(''),[showCreate,setShowCreate]=useState(false);
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[botId,setBotId]=useState(props.bots[0]?.id||''),[startImmediately,setStartImmediately]=useState(true),[draft,setDraft]=useState('');
  const createOperation=useRef<{key:string;id:string}|null>(null),sendOperation=useRef<{key:string;id:string}|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
  const loadTasks=useCallback(async(signal?:AbortSignal)=>{
    try {
      const result=await props.request('/v1/tasks',{signal});if(signal?.aborted)return;
      const current=taskList(result),active=current.filter(task=>activeStatuses.has(task.status));
      // Runs reads project terminal status and release durable computer slots.
      await Promise.all(active.map(task=>props.request(`/v1/tasks/${encodeURIComponent(task.id)}/runs`,{signal}).catch(()=>undefined)));
      if(signal?.aborted)return;
      const latest=active.length?await props.request('/v1/tasks',{signal}):result;
      if(!signal?.aborted){setTasks(taskList(latest));setLoadError('');}
    }
    catch(reason){if(!signal?.aborted)setLoadError(reason instanceof Error?reason.message:'Could not load tasks.');}
    finally{if(!signal?.aborted)setLoading(false);}
  },[props.request]);
  useEffect(()=>{const controller=new AbortController();void loadTasks(controller.signal);return()=>controller.abort()},[loadTasks]);
  useEffect(()=>{if(selected)return;const controller=new AbortController(),timer=setInterval(()=>void loadTasks(controller.signal),8000);return()=>{controller.abort();clearInterval(timer)}},[selected,loadTasks]);
  const loadDetail=useCallback(async(id:string,signal?:AbortSignal)=>{
    setLoadingMessages(true);setLoadError('');
    try {
      await props.request(`/v1/tasks/${encodeURIComponent(id)}/runs`,{signal}).catch(()=>undefined);
      const [taskResult,messageResult]=await Promise.all([props.request(`/v1/tasks/${encodeURIComponent(id)}`,{signal}),props.request(`/v1/tasks/${encodeURIComponent(id)}/messages`,{signal})]);
      if(signal?.aborted)return;
      setDetail(taskDetail(taskResult)||tasks.find(item=>item.id===id)||null);setMessages(messageList(messageResult));
    } catch(reason){if(!signal?.aborted)setLoadError(reason instanceof Error?reason.message:'Could not load task conversation.');}
    finally{if(!signal?.aborted)setLoadingMessages(false);}
  },[props.request,tasks]);
  useEffect(()=>{if(!selected){setDetail(null);setMessages([]);return;}const controller=new AbortController();void loadDetail(selected,controller.signal);return()=>controller.abort()},[selected,loadDetail]);
  useEffect(()=>{if(!selected)return;const timer=setInterval(()=>void loadDetail(selected),8000);return()=>clearInterval(timer)},[selected,loadDetail]);
  const refresh=()=>{void loadTasks();if(selected)void loadDetail(selected)};
  const create=async(event:FormEvent)=>{
    event.preventDefault();const trimmed=title.trim();if(!trimmed||!botId||creating)return;
    const key=JSON.stringify([trimmed,description,botId,startImmediately]);
    const operation=createOperation.current?.key===key?createOperation.current:{key,id:crypto.randomUUID()};createOperation.current=operation;
    setCreating(true);setError('');
    try {
      const result=await props.request('/v1/tasks',{method:'POST',body:{operationId:operation.id,title:trimmed,description:description.trim(),botId,startImmediately}});
      if(!mounted.current)return;
      const created=taskDetail(result);createOperation.current=null;setTitle('');setDescription('');setShowCreate(false);setStartImmediately(true);await loadTasks();
      if(created?.id)setSelected(created.id);
    } catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Could not create task.');}
    finally{if(mounted.current)setCreating(false);}
  };
  const send=async(event:FormEvent)=>{
    event.preventDefault();const value=draft.trim();if(!selected||!value||busy)return;
    const key=value,operation=sendOperation.current?.key===key?sendOperation.current:{key,id:crypto.randomUUID()};sendOperation.current=operation;
    setBusy(true);setError('');
    try {await props.request(`/v1/tasks/${encodeURIComponent(selected)}/messages`,{method:'POST',body:{operationId:operation.id,text:value}});if(!mounted.current)return;sendOperation.current=null;setDraft('');await loadDetail(selected);}
    catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Could not send message.');}
    finally{if(mounted.current)setBusy(false);}
  };
  const action=async(kind:'start'|'cancel')=>{
    if(!detail||busy)return;setBusy(true);setError('');
    try{await props.request(`/v1/tasks/${encodeURIComponent(detail.id)}/${kind}`,{method:'POST'});if(mounted.current){await loadTasks();await loadDetail(detail.id)}}
    catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:`Could not ${kind==='start'?'start':'cancel'} task.`)}
    finally{if(mounted.current)setBusy(false)}
  };
  const botNames=new Map(props.bots.map(bot=>[bot.id,bot.name]));
  const content=selected ? <section className="timber-tasks-detail" data-task-id={selected}>
    <header className="timber-tasks-detail-heading"><button type="button" className="timber-tasks-icon-button" aria-label="Back to tasks" onClick={()=>{setSelected(null);setError('')}}><ArrowLeftIcon/></button><div className="timber-tasks-title-block"><h2>{detail?.title||'Task'}</h2><span className="timber-tasks-subtitle">{detail?.botName||botNames.get(detail?.botId||'')||'Assigned bot'}{detail?.status&&<> · <span className="timber-task-status" data-status={detail.status}>{statusName(detail.status)}</span></>}</span></div><button type="button" className="timber-tasks-quiet" onClick={refresh} aria-label="Refresh task"><RefreshCwIcon/></button>{detail?.botId&&props.onOpenBot&&<button type="button" className="timber-tasks-quiet" onClick={()=>props.onOpenBot?.(detail.botId)}>Open bot</button>}</header>
    {detail?.description&&<p className="timber-tasks-description">{detail.description}</p>}
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError}</p>}
    <div className="timber-tasks-messages" aria-label="Task conversation" aria-live="polite">
      {(loadingMessages&&!messages.length)&&<p className="timber-tasks-hint">Loading task conversation…</p>}
      {!loadingMessages&&!messages.length&&<p className="timber-tasks-hint">No messages in this task yet.</p>}
      {messages.map((message,index)=><article className={`timber-task-message timber-task-message-${message.role}`} data-task-message-id={message.id} key={message.id||index}>
        <div className="timber-task-message-meta"><strong>{message.role==='user'?'You':message.role==='assistant'?(detail?.botName||botNames.get(detail?.botId||'')||'Assigned bot'):label(message.role||'message')}</strong>{message.createdAt&&<time>{date(message.createdAt)}</time>}</div>
        <MessageResponse className="timber-task-markdown" mode="static" skipHtml plugins={{}} components={{img:()=>null}} linkSafety={{enabled:false}} controls={false}>{message.text||''}</MessageResponse>
      </article>)}
    </div>
    {error&&<p className="timber-tasks-error" role="alert">{error}</p>}
    <div className="timber-tasks-controls">
      {detail?.status==='pending'&&<button type="button" className="timber-tasks-action" disabled={busy} onClick={()=>void action('start')}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<ArrowUpIcon/>}{busy?'Starting…':'Start task'}</button>}
      {detail&&activeStatuses.has(detail.status)&&<button type="button" className="timber-tasks-action is-secondary" disabled={busy} onClick={()=>void action('cancel')}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<SquareIcon/>}{busy?'Working…':'Cancel task'}</button>}
      {detail?.status&&['completed','failed','cancelled'].includes(detail.status)&&<span className="timber-tasks-hint">This task is {statusName(detail.status).toLowerCase()}.</span>}
    </div>
    {detail?.status!=='cancelled'&&<form className="timber-tasks-composer" onSubmit={event=>void send(event)}><label className="timber-tasks-sr-only" htmlFor="timber-task-draft">Message this task</label><textarea id="timber-task-draft" rows={2} value={draft} onChange={event=>setDraft(event.currentTarget.value)} placeholder="Message this task…"/><button type="submit" aria-label="Send task message" disabled={busy||!draft.trim()}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<ArrowUpIcon/>}</button></form>}
  </section> : <section className="timber-tasks-overview">
    <header className="timber-tasks-overview-heading"><div><h2>Tasks</h2><p>Independent work and conversations across your bots.</p></div><button type="button" className="timber-tasks-action" onClick={()=>{setShowCreate(value=>!value);setError('')}}><PlusIcon/>{showCreate?'Close':'New task'}</button></header>
    {showCreate&&<form className="timber-tasks-create" onSubmit={event=>void create(event)}><h3>Create a task</h3><label>Title<input autoFocus required maxLength={160} value={title} onChange={event=>setTitle(event.currentTarget.value)} placeholder="What needs to be done?"/></label><label>Description<textarea rows={3} value={description} onChange={event=>setDescription(event.currentTarget.value)} placeholder="Add context or instructions (optional)"/></label><label>Assigned bot<select required value={botId} onChange={event=>setBotId(event.currentTarget.value)}><option value="" disabled>Select a bot</option>{props.bots.map(bot=><option value={bot.id} key={bot.id}>{bot.name}</option>)}</select></label><label className="timber-tasks-checkbox"><input type="checkbox" checked={startImmediately} onChange={event=>setStartImmediately(event.currentTarget.checked)}/>Start immediately</label>{error&&<p className="timber-tasks-error" role="alert">{error}</p>}<div className="timber-tasks-form-actions"><button type="button" className="timber-tasks-quiet" onClick={()=>setShowCreate(false)}>Cancel</button><button type="submit" className="timber-tasks-action" disabled={creating||!props.bots.length||!title.trim()}>{creating&&<LoaderCircleIcon className="timber-tasks-spinner"/>}{creating?'Creating…':'Create task'}</button></div>{!props.bots.length&&<p className="timber-tasks-hint">Create a bot before assigning a task.</p>}</form>}
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError} <button type="button" className="timber-tasks-link" onClick={refresh}>Retry</button></p>}
    {!tasks.length&&<div className="timber-tasks-empty">{loading?<><LoaderCircleIcon className="timber-tasks-spinner"/><span>Loading tasks…</span></>:<><strong>No tasks yet</strong><span>Create a global task and assign it to a bot. Its conversation stays separate from bot chat.</span></>}</div>}
    {!!tasks.length&&<div className="timber-tasks-list">{tasks.map(task=><button type="button" className="timber-tasks-card" key={task.id} data-task-id={task.id} onClick={()=>{setSelected(task.id);setError('')}}><span className="timber-tasks-card-heading"><strong>{task.title}</strong><span className="timber-task-status" data-status={task.status}>{statusName(task.status)}</span></span><span className="timber-tasks-card-description">{task.description||'No description'}</span><span className="timber-tasks-card-footer"><span>{task.botName||botNames.get(task.botId)||'Assigned bot'}</span><time>{date(task.lastActivity||task.updatedAt||task.createdAt)}</time></span></button>)}</div>}
  </section>;
  return <div className="timber-tasks" role="region" aria-label="Global tasks"><div className="timber-tasks-topbar">{props.onClose&&<button type="button" className="timber-tasks-quiet" onClick={props.onClose}>Close</button>}</div>{content}</div>;
}

export function mountTasks(container:HTMLElement,props:TasksProps) {
  const root=createRoot(container);
  root.render(createElement(TaskView,{props}));
  return {update(next:TasksProps){root.render(createElement(TaskView,{props:next}))},unmount(){root.unmount()}};
}
