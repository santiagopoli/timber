import {memo} from 'react';
import {ArrowUpRightIcon, CheckIcon, CircleAlertIcon, ClockIcon, LoaderCircleIcon, SquareIcon} from 'lucide-react';
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
