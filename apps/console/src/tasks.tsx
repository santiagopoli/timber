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
function approvalList(value: unknown): TaskApproval[] {
  const source = isRecord(value) && Array.isArray(value.approvals) ? value.approvals : [];
  return source.filter(isRecord).map(item=>({id:text(item.id),status:text(item.status),action:isRecord(item.action)?item.action:{},expiresAt:text(item.expiresAt)})).filter(item=>item.id);
}
const approvalExpired = (approval:TaskApproval) => Boolean(approval.expiresAt && Date.parse(approval.expiresAt)<=Date.now());

function TaskView({props}:{props:TasksProps}) {
  const [tasks,setTasks]=useState<Task[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Task|null>(null),[messages,setMessages]=useState<TaskMessage[]>([]);
  const [loading,setLoading]=useState(true),[loadingMessages,setLoadingMessages]=useState(false),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState(''),[showCreate,setShowCreate]=useState(false),[filter,setFilter]=useState<TaskFilter>('all');
  const [approvals,setApprovals]=useState<TaskApproval[]>([]),[approvalError,setApprovalError]=useState('');
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[botId,setBotId]=useState(props.bots[0]?.id||''),[startImmediately,setStartImmediately]=useState(true),[draft,setDraft]=useState('');
  const createOperation=useRef<{key:string;id:string}|null>(null),sendOperation=useRef<{key:string;id:string}|null>(null),mounted=useRef(true);
  const selectedRef=useRef<string|null>(null),viewVersion=useRef(0),tasksRef=useRef(tasks);
  const listRead=useRef<AbortController|null>(null),detailRead=useRef<AbortController|null>(null);
  tasksRef.current=tasks;
  useEffect(()=>{
    // The task island can mount before the bot catalogue arrives, or outlive a bot.
    if(!props.bots.some(bot=>bot.id===botId))setBotId(props.bots[0]?.id||'');
  },[props.bots,botId]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;listRead.current?.abort();detailRead.current?.abort()};
  },[]);
  const selectTask=(id:string|null)=>{
    // Fence the old view synchronously, including switching away and back to the same task.
    viewVersion.current++;selectedRef.current=id;listRead.current?.abort();detailRead.current?.abort();setSelected(id);
    setDetail(null);setMessages([]);setApprovals([]);setDraft('');setBusy(false);setError('');setLoadError('');setApprovalError('');
  };
  const loadTasks=useCallback(async()=>{
    if(!mounted.current)return;
    listRead.current?.abort();const controller=new AbortController();listRead.current=controller;
    const current=()=>mounted.current&&!controller.signal.aborted&&listRead.current===controller;
    try {
      const result=await props.request('/v1/tasks',{signal:controller.signal});
      if(current()){setTasks(taskList(result));setLoadError('');}
    }
    catch(reason){if(current())setLoadError(reason instanceof Error?reason.message:'Could not load tasks.');}
    finally{if(current())setLoading(false);}
  },[props.request]);
  useEffect(()=>{void loadTasks();return()=>listRead.current?.abort()},[loadTasks]);
  useEffect(()=>{if(selected)return;const timer=setInterval(()=>void loadTasks(),8000);return()=>{listRead.current?.abort();clearInterval(timer)}},[selected,loadTasks]);
  const loadDetail=useCallback(async(id:string)=>{
    if(!mounted.current||selectedRef.current!==id)return;
    detailRead.current?.abort();const controller=new AbortController();detailRead.current=controller;
    const version=viewVersion.current;
    const current=()=>mounted.current&&!controller.signal.aborted&&detailRead.current===controller&&selectedRef.current===id&&viewVersion.current===version;
    setLoadingMessages(true);
    try {
      const path=`/v1/tasks/${encodeURIComponent(id)}`,options={signal:controller.signal};
      const [taskResult,messageResult,approvalResult]=await Promise.all([
        props.request(path,options),props.request(`${path}/messages`,options),
        props.request(`${path}/approvals`,options).then(value=>({value,error:''}),reason=>({value:null,error:reason instanceof Error?reason.message:'Could not load task approvals.'})),
      ]);
      if(!current())return;
      setDetail(taskDetail(taskResult)||tasksRef.current.find(item=>item.id===id)||null);setMessages(messageList(messageResult));setLoadError('');
      setApprovalError(approvalResult.error);if(!approvalResult.error)setApprovals(approvalList(approvalResult.value));
    } catch(reason){if(current())setLoadError(reason instanceof Error?reason.message:'Could not load task conversation.');}
    finally{if(current())setLoadingMessages(false);}
  },[props.request]);
  useEffect(()=>{
    if(!selected)return;
    void loadDetail(selected);const timer=setInterval(()=>void loadDetail(selected),8000);
    return()=>{detailRead.current?.abort();clearInterval(timer)};
  },[selected,loadDetail]);
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
  const visibleTasks=tasks.filter(task=>filter==='all'||(filter==='active'?activeStatuses.has(task.status):task.status===filter));
  const canDecideApproval=Boolean(detail&&['running','waiting_approval','waiting_connection'].includes(detail.status));
  const waitingApprovals=approvals.filter(approval=>['pending','approved','executing'].includes(approval.status));
  const content=selected ? <section className="timber-tasks-detail" data-task-id={selected}>
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
      {detail&&activeStatuses.has(detail.status)&&detail.status!=='cancelling'&&<button type="button" className="timber-tasks-action is-secondary" disabled={busy} onClick={()=>void action('cancel')}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:<SquareIcon/>}{busy?'Working…':'Cancel task'}</button>}
      {detail?.status&&['completed','failed','cancelled'].includes(detail.status)&&<span className="timber-tasks-hint">This task is {statusName(detail.status).toLowerCase()}.</span>}
    </div>
    {detail&&['completed','failed'].includes(detail.status)&&<p className="timber-tasks-hint">Continue with new instructions below. This starts a new run in this task, without replaying old actions.</p>}
    {detail?.status==='cancelled'&&<p className="timber-tasks-hint">Cancelled tasks stay stopped. Create a new task to work again.</p>}
    {detail&&['running','waiting_approval','waiting_connection','completed','failed'].includes(detail.status)&&<form className="timber-tasks-composer" onSubmit={event=>void send(event)}><label className="timber-tasks-sr-only" htmlFor="timber-task-draft">Message this task</label><textarea id="timber-task-draft" rows={2} value={draft} onChange={event=>setDraft(event.currentTarget.value)} placeholder={['completed','failed'].includes(detail.status)?'New instructions to continue this task…':'Message this task…'}/><button type="submit" aria-label={['completed','failed'].includes(detail.status)?'Continue task':'Send task message'} disabled={busy||!draft.trim()}>{busy?<LoaderCircleIcon className="timber-tasks-spinner"/>:['completed','failed'].includes(detail.status)?'Continue':<ArrowUpIcon/>}</button></form>}
  </section> : <section className="timber-tasks-overview">
    <header className="timber-tasks-overview-heading"><div><h2>Tasks</h2><p>Independent work and conversations across your bots.</p></div><button type="button" className="timber-tasks-action" onClick={()=>{setShowCreate(value=>!value);setError('')}}><PlusIcon/>{showCreate?'Close':'New task'}</button></header>
    {showCreate&&<form className="timber-tasks-create" onSubmit={event=>void create(event)}><h3>Create a task</h3><label>Title<input autoFocus required maxLength={160} value={title} onChange={event=>setTitle(event.currentTarget.value)} placeholder="What needs to be done?"/></label><label>Description<textarea rows={3} maxLength={32000} value={description} onChange={event=>setDescription(event.currentTarget.value)} placeholder="Add context or instructions (optional)"/></label><label>Assigned bot<select required value={botId} onChange={event=>setBotId(event.currentTarget.value)}><option value="" disabled>Select a bot</option>{props.bots.map(bot=><option value={bot.id} key={bot.id}>{bot.name}</option>)}</select></label><label className="timber-tasks-checkbox"><input type="checkbox" checked={startImmediately} onChange={event=>setStartImmediately(event.currentTarget.checked)}/>Start immediately</label>{error&&<p className="timber-tasks-error" role="alert">{error}</p>}<div className="timber-tasks-form-actions"><button type="button" className="timber-tasks-quiet" onClick={()=>setShowCreate(false)}>Cancel</button><button type="submit" className="timber-tasks-action" disabled={creating||!props.bots.length||!title.trim()}>{creating&&<LoaderCircleIcon className="timber-tasks-spinner"/>}{creating?'Creating…':'Create task'}</button></div>{!props.bots.length&&<p className="timber-tasks-hint">Create a bot before assigning a task.</p>}</form>}
    <div className="timber-tasks-filters" role="group" aria-label="Filter tasks by status">{(['all','active','pending','completed'] as TaskFilter[]).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==='all'?'All':value==='active'?'Active':statusName(value)}</button>)}</div>
    {loadError&&<p className="timber-tasks-error" role="alert">{loadError} <button type="button" className="timber-tasks-link" onClick={refresh}>Retry</button></p>}
    {!tasks.length&&<div className="timber-tasks-empty">{loading?<><LoaderCircleIcon className="timber-tasks-spinner"/><span>Loading tasks…</span></>:<><strong>No tasks yet</strong><span>Create a global task and assign it to a bot. Its conversation stays separate from bot chat.</span></>}</div>}
    {!!tasks.length&&!visibleTasks.length&&<div className="timber-tasks-empty"><strong>No {filter} tasks</strong><span>Choose another filter to see other tasks.</span></div>}
    {!!visibleTasks.length&&<div className="timber-tasks-list">{visibleTasks.map(task=><button type="button" className="timber-tasks-card" key={task.id} data-task-id={task.id} onClick={()=>selectTask(task.id)}><span className="timber-tasks-card-heading"><strong>{task.title}</strong><span className="timber-task-status" data-status={task.status}>{statusName(task.status)}</span></span><span className="timber-tasks-card-description">{task.description||'No description'}</span><span className="timber-tasks-card-footer"><span>{task.botName||botNames.get(task.botId)||'Assigned bot'}</span><time>{date(task.lastActivity||task.updatedAt||task.createdAt)}</time></span></button>)}</div>}
  </section>;
  return <div className="timber-tasks" role="region" aria-label="Global tasks"><div className="timber-tasks-topbar">{props.onClose&&<button type="button" className="timber-tasks-quiet" onClick={props.onClose}>Close</button>}</div>{content}</div>;
}

export function mountTasks(container:HTMLElement,props:TasksProps) {
  const root=createRoot(container);
  root.render(createElement(TaskView,{props}));
  return {update(next:TasksProps){root.render(createElement(TaskView,{props:next}))},unmount(){root.unmount()}};
}
