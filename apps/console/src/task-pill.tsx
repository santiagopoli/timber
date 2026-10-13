import {memo,useId,useState} from 'react';
import {ArrowUpRightIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon, ClockIcon, LoaderCircleIcon, SquareIcon} from 'lucide-react';
import type {ChatTaskSummary} from './chat-types';
import './task-pill.css';

const names:Record<string,string>={pending:'Pending',queued:'Queued',running:'Working',waiting_approval:'Needs approval',waiting_connection:'Needs connection',cancelling:'Stopping',completed:'Completed',failed:'Failed',cancelled:'Stopped'};
export const TaskPill=memo(function TaskPill({task,onOpenTask}:{task:ChatTaskSummary;onOpenTask?:(id:string)=>void}) {
  const status=names[task.status]||task.status.replaceAll('_',' ');
  const Icon=task.status==='completed'?CheckIcon:task.status==='failed'?CircleAlertIcon:task.status==='cancelled'?SquareIcon:['running','cancelling'].includes(task.status)?LoaderCircleIcon:ClockIcon;
  return <button type="button" className="timber-task-pill" data-linked-task-id={task.id} data-task-status={task.status} aria-label={`Open task: ${task.title} · ${status}`} onClick={()=>onOpenTask?.(task.id)} disabled={!onOpenTask}>
    <Icon className={['running','cancelling'].includes(task.status)?'timber-task-pill-spinner':''} aria-hidden="true"/>
    <span className="timber-task-pill-title">{task.title}</span><span className="timber-task-pill-status" role="status">{status}</span><ArrowUpRightIcon aria-hidden="true"/>
  </button>;
});


export const TaskMessagePill=memo(function TaskMessagePill({task,onOpenTask}:{task:{taskId:string;title:string;status:string;text?:string;result?:string;error?:string;label:string};onOpenTask?:(id:string)=>void}) {
  const [expanded,setExpanded]=useState(false),bodyId=useId();
  const status=task.status==='accepted'?'Accepted':task.status==='sending'?'Sending':task.status==='failed'?'Failed':task.status==='interrupted'?'Interrupted':task.status==='cancelled'?'Cancelled':task.status==='queued'?'Queued':task.status.replaceAll('_',' ');
  return <article className="timber-task-pill-wrap" data-task-status={task.status} data-linked-task-id={task.taskId}>
    <button type="button" className="timber-task-pill timber-task-pill-disclosure" data-task-status={task.status} aria-label={`${task.title} · ${task.label} · ${status}`} aria-expanded={expanded} aria-controls={bodyId} onClick={()=>setExpanded(value=>!value)}>
      <ClockIcon aria-hidden="true"/><span className="timber-task-pill-title">{task.title}</span><span className="timber-task-pill-status">{task.label} · {status}</span><ChevronDownIcon aria-hidden="true" style={{transform:expanded?'rotate(180deg)':undefined}}/>
    </button>
    {expanded&&<div className="timber-task-pill-details" id={bodyId}>
      {task.text&&<p>{task.text}</p>}{task.result&&<p>{task.result}</p>}{task.error&&<p className="timber-inline-error">{task.error}</p>}
      {onOpenTask&&<button type="button" className="timber-task-pill-open" onClick={()=>onOpenTask(task.taskId)}>Open task <ArrowUpRightIcon aria-hidden="true"/></button>}
    </div>}
  </article>;
});
