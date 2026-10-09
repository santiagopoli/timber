import {useId, useState} from 'react';
import {BrainIcon, ChevronDownIcon} from 'lucide-react';
import type {BotEvent, CompactionReceipt} from '../../../packages/contracts/src/index';
import './compaction-timeline.css';

/** Only public, recorded maintenance metadata belongs here, never raw native tasks. */
export type CompactionItem = CompactionReceipt & {
  key:string;
  createdAt:string;
  /** No recorded date: render in the unpositioned history group, not as a dated event. */
  unpositioned:boolean;
  runId?:string;
  subagentId?:string;
  eventId?:number;
  timestampSource?:'createdAt'|'startedAt'|'summaryCreatedAt';
};
type TimelineModel = {
  events:BotEvent[];
  compactionEvents?:BotEvent[];
  compactions?:readonly CompactionReceipt[];
  runFilter?:string|null;
};
const reasons = new Set(['manual','threshold','overflow']);
const statuses = new Set(['running','completed','unchanged','failed','cancelled']);
const record = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const text = (value:unknown):string|undefined => typeof value==='string' && value.length ? value : undefined;
const count = (value:unknown):number|undefined => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : undefined;
const date = (value:unknown):string|undefined => typeof value==='string' && Number.isFinite(Date.parse(value)) ? value : undefined;

function project(value:unknown, event?:BotEvent):CompactionItem|undefined {
  const receipt=record(value),id=text(receipt.id);
  const timestampSource=date(receipt.createdAt)?'createdAt':date(receipt.startedAt)?'startedAt':date(receipt.summaryCreatedAt)?'summaryCreatedAt':undefined;
  const createdAt=timestampSource ? String(receipt[timestampSource]) : date(event?.createdAt) ?? '';
  // Historical native tasks can lack timestamps. Keep their occurrence visible
  // with an explicit unknown time, never a fabricated reload/fetch timestamp.
  if(!id || !reasons.has(String(receipt.reason)) || !statuses.has(String(receipt.status)) || typeof receipt.summaryApplied!=='boolean')return;
  const subagentId=text(receipt.subagentId) ?? text(event?.data.subagentId);
  return {
    key:`compaction:${id}`,id,createdAt,timestampSource,unpositioned:!createdAt,
    reason:receipt.reason as CompactionReceipt['reason'],status:receipt.status as CompactionReceipt['status'],summaryApplied:receipt.summaryApplied,
    ...(date(receipt.startedAt)?{startedAt:date(receipt.startedAt)}:{}),
    ...(date(receipt.summaryCreatedAt)?{summaryCreatedAt:date(receipt.summaryCreatedAt)}:{}),
    ...(count(receipt.firstKeptEntryId)===undefined?{}:{firstKeptEntryId:count(receipt.firstKeptEntryId)}),
    ...(count(receipt.summarizedEntries)===undefined?{}:{summarizedEntries:count(receipt.summarizedEntries)}),
    ...(count(receipt.estimatedTokensBefore)===undefined?{}:{estimatedTokensBefore:count(receipt.estimatedTokensBefore)}),
    ...(receipt.historyRetained===true?{historyRetained:true as const}:{}),
    ...(event?.runId?{runId:event.runId}:text(receipt.runId)?{runId:text(receipt.runId)}:{}),
    ...(subagentId?{subagentId}:{}),
    ...(event?{eventId:event.id}:{}),
    ...(text(receipt.error)?{error:text(receipt.error)}:{}),
  };
}

/**
 * Each durable receipt ID is one occurrence. SSE replays and lifecycle updates
 * merge into it; two equal summaries/reasons at the same time never collapse.
 * Preferred event: context.compaction {compaction: public CompactionReceipt}.
 * A dedicated unbounded compactionEvents store survives the activity ring limit.
 */
export function collectCompactions(model:TimelineModel,scopeSubagentId?:string):CompactionItem[] {
  const items=new Map<string,CompactionItem>();
  const merge=(next:CompactionItem)=>{
    const previous=items.get(next.id);
    if(!previous){items.set(next.id,next);return;}
    const previousVersion=Date.parse(previous.summaryCreatedAt ?? previous.createdAt)||0,nextVersion=Date.parse(next.summaryCreatedAt ?? next.createdAt)||0;
    const older=nextVersion<previousVersion || nextVersion===previousVersion && (next.eventId ?? -1)<(previous.eventId ?? -1);
    if(older)return;
    // A running replay cannot reopen a settled occurrence. Placement remains at
    // its original timestamp even when legacy events omitted receipt.createdAt.
    if(previous.status!=='running' && next.status==='running')return;
    items.set(next.id,{...previous,...next,createdAt:previous.createdAt||next.createdAt,timestampSource:previous.timestampSource||next.timestampSource,unpositioned:!(previous.createdAt||next.createdAt)});
  };
  for(const receipt of model.compactions ?? []){const item=project(receipt);if(item)merge(item);}
  const events=[...(model.compactionEvents ?? []),...model.events].filter(event=>event.type==='context.compaction').sort((left,right)=>left.id-right.id);
  for(const event of events){const item=project(event.data.compaction,event);if(item)merge(item);}
  return [...items.values()]
    .filter(item=>scopeSubagentId ? item.subagentId===scopeSubagentId : !item.subagentId)
    .filter(item=>!model.runFilter || item.runId===model.runFilter)
    .sort((left,right)=>(Date.parse(left.createdAt)||0)-(Date.parse(right.createdAt)||0)||(left.eventId ?? 0)-(right.eventId ?? 0)||left.id.localeCompare(right.id));
}

const reasonLabel:Record<CompactionReceipt['reason'],string> = {manual:'Manual',threshold:'Automatic · context threshold',overflow:'Automatic · context overflow'};
const statusLabel:Record<CompactionReceipt['status'],string> = {running:'Compacting context',completed:'Context compacted',unchanged:'Context unchanged',failed:'Compaction failed',cancelled:'Compaction cancelled'};
const statusDetail:Record<CompactionReceipt['status'],string> = {
  running:'Older context is being summarized. Your conversation history stays available.',
  completed:'The model context was compacted. Your full conversation history is retained.',
  unchanged:'No context change was applied. Your full conversation history is retained.',
  failed:'Compaction could not finish. Your conversation history is retained.',
  cancelled:'Compaction was cancelled. Your conversation history is retained.',
};

export function CompactionPill({item}:{item:CompactionItem}) {
  const [expanded,setExpanded]=useState(false),bodyId=useId();
  const timeLabel=item.timestampSource==='summaryCreatedAt'?'Summary recorded':item.timestampSource==='startedAt'?'Started':'Created';
  return <article className="timber-compaction" data-compaction-id={item.id} data-compaction-status={item.status} data-run-id={item.runId} data-compaction-unpositioned={item.unpositioned||undefined}>
    <button type="button" className="timber-compaction-pill" aria-expanded={expanded} aria-controls={bodyId} aria-label={`${expanded?'Hide':'Show'} compaction details`} onClick={()=>setExpanded(value=>!value)}>
      <BrainIcon className="timber-compaction-icon" aria-hidden="true"/>
      <span className="timber-compaction-label"><strong>{statusLabel[item.status]}</strong><span>{reasonLabel[item.reason]}{item.unpositioned&&<> · Date unavailable</>}</span></span>
      <ChevronDownIcon className={`timber-compaction-toggle${expanded?' is-expanded':''}`} aria-hidden="true"/>
    </button>
    {expanded && <div className="timber-compaction-details" id={bodyId}>
      <p>{statusDetail[item.status]}</p>
      {item.error&&<p className="timber-compaction-error">{item.error}</p>}
      <dl>
        <div><dt>{timeLabel}</dt><dd>{item.createdAt?<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>:'Date unavailable'}</dd></div>
        <div><dt>Summary applied</dt><dd>{item.summaryApplied?'Yes':item.status==='running'?'Not yet':'No'}</dd></div>
        {item.summaryCreatedAt&&item.timestampSource!=='summaryCreatedAt'&&<div><dt>Summary recorded</dt><dd><time dateTime={item.summaryCreatedAt}>{new Date(item.summaryCreatedAt).toLocaleString()}</time></dd></div>}
        {item.estimatedTokensBefore!==undefined&&<div><dt>Selected-prefix tokens (estimate)</dt><dd>{item.estimatedTokensBefore.toLocaleString()}</dd></div>}
        {item.firstKeptEntryId!==undefined&&<div><dt>First entry kept verbatim</dt><dd>{item.firstKeptEntryId}</dd></div>}
        {item.summarizedEntries!==undefined&&<div><dt>Entries selected for summary</dt><dd>{item.summarizedEntries.toLocaleString()}</dd></div>}
      </dl>
      <p className="timber-compaction-unavailable">Internal summary text is not exposed. Only recorded compaction details are shown.</p>
    </div>}
  </article>;
}
