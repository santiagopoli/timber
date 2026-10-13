import {useEffect,useRef,useState} from 'react';
import {Dialog} from 'radix-ui';
import {BrainIcon,LoaderCircleIcon,PlusIcon,SearchIcon,XIcon} from 'lucide-react';
import type {BotContextStatus,BotMemory,CompactionReceipt,MemoryCategory,MemoryContextPreview,MemoryEntry,MemoryMutationResult,MemoryRevision,MemorySearchResult} from '../../../packages/contracts/src/index';
import './context-memory.css';

export type ContextMemoryRequest=(botId:string,path:string,options?:{method?:string;body?:unknown;signal?:AbortSignal})=>Promise<unknown>;
const categories:Record<MemoryCategory,string>={preference:'Preferences',fact:'Facts',decision:'Decisions',procedure:'Procedures'};
type Draft={id?:string;expectedRevision?:number;category:MemoryCategory;title:string;content:string;pinned:boolean};
type Pending={botId:string;path:string;method:string;body:Record<string,unknown>;label:string;editor?:boolean;undoRevision?:{id:string;revision:number;suggestion:boolean}};
const message=(reason:unknown)=>reason instanceof Error?reason.message:'The request could not be confirmed. Try again.';
const date=(value:string)=>new Date(value).toLocaleString();

function LegacyExport({content,botId}:{content:string;botId:string}) {
  const [url,setURL]=useState('');
  useEffect(()=>{const value=URL.createObjectURL(new Blob([content],{type:'text/plain'}));setURL(value);return()=>URL.revokeObjectURL(value);},[content]);
  return <a className="quiet" download={`timber-memory-${botId}.txt`} href={url}>Export previous memory</a>;
}

function MemoryPreview({botId,request,revision}:{botId:string;request:ContextMemoryRequest;revision:number}) {
  const [expanded,setExpanded]=useState(false),[query,setQuery]=useState(''),[preview,setPreview]=useState<MemoryContextPreview>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!expanded)return;
    const controller=new AbortController();setLoading(true);setError('');setPreview(undefined);
    const timer=setTimeout(()=>{void request(botId,`/memory/context?q=${encodeURIComponent(query.trim())}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setPreview((value as {context:MemoryContextPreview}).context);}).catch(reason=>{if(!controller.signal.aborted)setError(message(reason));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});},250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[botId,request,expanded,query,revision,attempt]);
  return <details className="timber-memory-preview" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary>What the agent remembers</summary>
    <p className="hint">See the notes selected for a task. This memory budget is separate from your conversation context.</p>
    <label>Task to preview <small>optional</small><input type="search" aria-label="Task to preview" placeholder="For example, prepare a release" maxLength={200} value={query} onChange={event=>setQuery(event.currentTarget.value)}/></label>
    {loading&&<p role="status" className="hint">Selecting memories…</p>}
    {error&&<div role="alert" className="timber-memory-error"><p>{error}</p><button type="button" className="quiet" onClick={()=>setAttempt(value=>value+1)}>Retry preview</button></div>}
    {preview&&<div className="timber-memory-preview-result">
      <div className="timber-memory-line"><strong>{preview.selected.length} {preview.selected.length===1?'note selected':'notes selected'}</strong><small>{preview.usedCharacters.toLocaleString()} / {preview.maxCharacters.toLocaleString()} characters</small></div>
      <meter aria-label="Memory character budget" min={0} max={preview.maxCharacters} value={preview.usedCharacters}/>
      {preview.selected.length?<ul aria-label="Selected memories">{preview.selected.map(item=><li key={`${item.scope}:${item.id}`}><span>{item.title}</span><small>{item.scope==='inherited'?'Inherited':'This agent'}</small></li>)}</ul>:<p className="hint">No notes selected for this task.</p>}
      {preview.omittedCount>0&&<p className="hint">{preview.omittedCount} {preview.omittedCount===1?'other note is':'other notes are'} outside this selection.</p>}
      {preview.text&&<details className="timber-memory-preview-text"><summary>Read selected memory</summary><pre>{preview.text}</pre></details>}
    </div>}
  </details>;
}

function MemoryNote({entry,replaces,request,botId,disabled,onEdit,onForget,onAccept,onRestore}: {entry:MemoryEntry;replaces?:MemoryEntry;request:ContextMemoryRequest;botId:string;disabled:boolean;onEdit:()=>void;onForget:()=>void;onAccept?:()=>void;onRestore:(revision:number,suggestion:boolean)=>void}) {
  const [history,setHistory]=useState<MemoryRevision[]>(),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const loadHistory=async()=>{setLoading(true);setError('');try{const result=await request(botId,`/memory/entries/${encodeURIComponent(entry.id)}/history`) as {history:MemoryRevision[]};if(alive.current)setHistory(result.history);}catch(reason){if(alive.current)setError(message(reason));}finally{if(alive.current)setLoading(false);}};
  const canRestoreSuggestion=entry.state==='suggested'||history?.some(item=>item.entry.revision===entry.revision&&item.operation==='accept');
  const staleReplacement=Boolean(entry.state==='suggested'&&entry.replacesId&&(!replaces||replaces.revision!==entry.replacesRevision));
  return <article className="timber-memory-note" data-memory-entry={entry.id}>
    <div className="timber-memory-note-title"><strong>{entry.title}</strong>{entry.pinned&&<small>Pinned</small>}</div>
    <p className="timber-memory-note-content">{entry.content}</p>{entry.state==='suggested'&&entry.replacesId&&<details className="timber-memory-replacement"><summary>Replaces {replaces?.title||'an earlier note'}</summary>{replaces?<p>{replaces.content}</p>:<p>The earlier note is no longer active. Review this suggestion before accepting.</p>}</details>}{staleReplacement&&<p className="hint" role="status">The original note changed. Edit the active note or discard this suggestion.</p>}
    <div className="timber-memory-note-actions">{onAccept&&<button type="button" className="quiet" disabled={disabled||staleReplacement} onClick={onAccept}>Accept</button>}<button type="button" className="quiet" disabled={disabled} onClick={onEdit}>{onAccept?'Correct':'Edit'}</button><button type="button" className="quiet" disabled={disabled} onClick={onForget}>{onAccept?'Discard':'Forget'}</button><details><summary>Source & history</summary><div className="timber-memory-provenance"><p>{entry.actor==='user'?'Added by you':entry.actor==='review'?'Learned from conversation':'Saved by agent'} · revision {entry.revision}</p>{entry.sources.length?entry.sources.map((source,index)=><div key={index}><small>{source.kind==='user'?'Your memory edit':source.role==='user'?'Your message':source.role==='assistant'?'Assistant message':'Conversation'}{source.createdAt?` · ${date(source.createdAt)}`:''}</small>{source.quote&&<blockquote>{source.quote}</blockquote>}</div>):<p>No source quote recorded.</p>}{entry.replacesId&&<p>{entry.state==='suggested'?'Suggested correction to an existing note. Accepting replaces that note.':'Accepted correction to an earlier note.'}</p>}<button type="button" className="quiet" disabled={loading} onClick={()=>void loadHistory()}>{loading?'Loading…':history?'Refresh revisions':'View revisions'}</button>{error&&<p role="alert" className="timber-memory-error">{error}</p>}{history&&<ol className="timber-memory-revisions">{history.map(item=><li key={`${item.entry.revision}:${item.operation}`} data-memory-revision={item.entry.revision}><small>Revision {item.entry.revision} · {item.operation} · {date(item.at)}</small><strong>{item.entry.title}</strong><p>{item.entry.content}</p>{item.entry.revision<entry.revision&&(item.entry.state!=='suggested'||canRestoreSuggestion)&&<button type="button" className="quiet" disabled={disabled} onClick={()=>onRestore(item.entry.revision,item.entry.state==='suggested')}>{item.entry.state==='suggested'?'Restore suggestion':'Restore this revision'}</button>}</li>)}</ol>}</div></details></div>
  </article>;
}

export function ContextMemoryControl({botId,request,refreshKey}: {botId:string;request:ContextMemoryRequest;refreshKey?:string|number}) {
  const [open,setOpen]=useState(false),[context,setContext]=useState<BotContextStatus>(),[memory,setMemory]=useState<BotMemory>();
  const [draft,setDraft]=useState<Draft>(),[query,setQuery]=useState(''),[results,setResults]=useState<MemorySearchResult>(),[searching,setSearching]=useState(false);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[compacting,setCompacting]=useState(false),[retry,setRetry]=useState<Pending>(),[conflict,setConflict]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[undo,setUndo]=useState<Pending>();
  const pending=useRef<Pending|undefined>(undefined),pendingCompact=useRef<{botId:string;operationId:string}|undefined>(undefined),currentBot=useRef(botId),epoch=useRef(0);currentBot.current=botId;
  const valid=(scope:number)=>currentBot.current===botId&&scope===epoch.current;
  const loadMemory=async(signal?:AbortSignal)=>{const scope=epoch.current,result=await request(botId,'/memory',{signal}) as {memory:BotMemory};if(!signal?.aborted&&valid(scope))setMemory(result.memory);};
  const loadContext=async(signal?:AbortSignal)=>{const scope=epoch.current,result=await request(botId,'/context',{signal}) as {context:BotContextStatus};if(!signal?.aborted&&valid(scope))setContext(result.context);};
  useEffect(()=>{epoch.current++;pending.current=undefined;pendingCompact.current=undefined;setContext(undefined);setMemory(undefined);setDraft(undefined);setQuery('');setResults(undefined);setError('');setNotice('');setRetry(undefined);setBusy(false);setCompacting(false);setConflict(false);setUndo(undefined);return()=>{epoch.current++;};},[botId]);
  useEffect(()=>{if(!open)return;const controller=new AbortController();setLoading(true);void Promise.all([loadContext(controller.signal),loadMemory(controller.signal)]).catch(reason=>{if(!controller.signal.aborted)setError(message(reason));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[botId,open]);
  const running=Boolean(context?.compactions.some(item=>item.status==='running')),reviewing=memory?.review.status==='queued'||memory?.review.status==='running';
  useEffect(()=>{if(!open||(!running&&!reviewing))return;const controller=new AbortController();const timer=setInterval(()=>{void Promise.all([loadContext(controller.signal),loadMemory(controller.signal)]).catch(reason=>{if(!controller.signal.aborted)setError(message(reason));});},2000);return()=>{clearInterval(timer);controller.abort();};},[botId,open,running,reviewing]);
  useEffect(()=>{if(!open)return;const controller=new AbortController();const timer=setTimeout(()=>void loadMemory(controller.signal).catch(reason=>{if(!controller.signal.aborted)setError(message(reason));}),800);return()=>{clearTimeout(timer);controller.abort();};},[botId,open,refreshKey]);
  useEffect(()=>{setResults(undefined);if(!open||!query.trim()){setSearching(false);return;}const controller=new AbortController(),scope=epoch.current;setSearching(true);const timer=setTimeout(()=>{void request(botId,`/memory/search?q=${encodeURIComponent(query.trim())}&limit=50`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted&&valid(scope))setResults((value as {results:MemorySearchResult}).results);}).catch(reason=>{if(!controller.signal.aborted&&valid(scope))setError(message(reason));}).finally(()=>{if(!controller.signal.aborted&&valid(scope))setSearching(false);});},250);return()=>{clearTimeout(timer);controller.abort();};},[botId,open,query,memory?.revision]);
  const perform=async(operation:Pending)=>{
    if(busy||operation.botId!==currentBot.current)return;const scope=epoch.current;pending.current=operation;setBusy(true);setRetry(undefined);setError('');setNotice('');
    try{const response=await request(botId,operation.path,{method:operation.method,body:operation.body}) as {result?:MemoryMutationResult};if(!valid(scope))return;pending.current=undefined;if(operation.editor){setDraft(undefined);setConflict(false);}setNotice(operation.label);
      const previous=operation.undoRevision,entry=response.result?.entry;
      setUndo(previous&&entry?.id===previous.id?{botId,path:`/memory/entries/${encodeURIComponent(previous.id)}/restore`,method:'POST',body:{operationId:crypto.randomUUID(),expectedRevision:entry.revision,revision:previous.revision},label:previous.suggestion?'Suggestion restored.':'Note restored.'}:undefined);
      try{await loadMemory();}catch(reason){if(valid(scope))setError(`Saved, but memory could not refresh: ${message(reason)}`);}}
    catch(reason){if(!valid(scope))return;const status=(reason as {status?:number}).status;setError(message(reason));if(status&&status>=400&&status<500&&status!==408&&status!==429){pending.current=undefined;if(status===409&&operation.editor)setConflict(true);try{await loadMemory();}catch{/* Keep the original mutation error and the draft. */}}else setRetry(operation);}
    finally{if(valid(scope))setBusy(false);}
  };
  const mutate=(path:string,method:string,body:Record<string,unknown>,label:string,editor=false,undoRevision?:Pending['undoRevision'])=>void perform({botId,path,method,body:{...body,operationId:crypto.randomUUID()},label,editor,undoRevision});
  const compact=async()=>{
    if(compacting||running)return;const scope=epoch.current,operation=pendingCompact.current?.botId===botId?pendingCompact.current:{botId,operationId:crypto.randomUUID()};pendingCompact.current=operation;setCompacting(true);setError('');
    try{const result=await request(botId,'/context/compact',{method:'POST',body:{operationId:operation.operationId}}) as {compaction:CompactionReceipt};if(!valid(scope))return;pendingCompact.current=undefined;setNotice(result.compaction.status==='running'?'Compaction requested. Your full conversation stays available.':'');await loadContext();}catch(reason){if(valid(scope))setError(message(reason));}finally{if(valid(scope))setCompacting(false);}
  };
  const startEdit=(entry?:MemoryEntry)=>{setDraft(entry?{id:entry.id,expectedRevision:entry.revision,category:entry.category,title:entry.title,content:entry.content,pinned:entry.pinned}:{category:'fact',title:'',content:'',pinned:false});setConflict(false);setError('');setNotice('');};
  const latest=context?.compactions[0],locked=busy||Boolean(retry),editing=draft?.id?memory?.entries.concat(memory.suggestions).find(item=>item.id===draft.id):undefined;
  const entries=query.trim()?(results?.hits.map(hit=>hit.entry)||[]):memory?.entries||[];
  const note=(entry:MemoryEntry,suggestion=false)=><MemoryNote key={`${entry.id}:${entry.revision}`} entry={entry} replaces={entry.replacesId?memory?.entries.find(item=>item.id===entry.replacesId):undefined} request={request} botId={botId} disabled={locked} onEdit={()=>startEdit(entry)} onForget={()=>mutate(`/memory/entries/${encodeURIComponent(entry.id)}`,'DELETE',{expectedRevision:entry.revision},suggestion?'Suggestion discarded.':'Note forgotten.',false,{id:entry.id,revision:entry.revision,suggestion})} onRestore={(revision,restoreSuggestion)=>mutate(`/memory/entries/${encodeURIComponent(entry.id)}/restore`,'POST',{expectedRevision:entry.revision,revision},restoreSuggestion?'Suggestion restored.':'Note restored.')} onAccept={suggestion?()=>mutate(`/memory/entries/${encodeURIComponent(entry.id)}/accept`,'POST',{expectedRevision:entry.revision,...(entry.replacesId?{replacesRevision:entry.replacesRevision}:{})},'Suggestion accepted.',false,{id:entry.id,revision:entry.revision,suggestion:true}):undefined}/>;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="timber-memory-trigger" aria-label="Context and memory"><BrainIcon aria-hidden="true"/><span>Context</span></button></Dialog.Trigger>
    <Dialog.Portal container={document.fullscreenElement||document.body}>
      {open&&<div className="timber-memory-overlay" aria-hidden="true"/>}
      <Dialog.Content className="timber-memory-dialog">
        <div className="timber-memory-heading"><Dialog.Title>Context and memory</Dialog.Title><Dialog.Close className="quiet icon-button" aria-label="Close context and memory"><XIcon aria-hidden="true"/></Dialog.Close></div>
        <Dialog.Description>Memory keeps useful preferences, facts and decisions. Your full conversation is saved separately.</Dialog.Description>
        {loading&&<p role="status"><LoaderCircleIcon className="timber-spinner"/>Loading…</p>}
        {context&&<details className="timber-memory-context"><summary>Conversation context · about {context.estimatedTokens.toLocaleString()} tokens</summary><p className="hint">Older context is summarized automatically. {context.contextWindow.toLocaleString()} token model window. Recent messages remain in context.</p><button type="button" className="quiet" disabled={compacting||running} onClick={()=>void compact()}>{compacting||running?'Compacting…':'Compact now'}</button>{latest&&<p role="status" data-compaction-status={latest.status}>{latest.status==='running'?'Summarizing older context…':latest.status==='completed'?'Context compacted. Full history retained.':latest.status==='unchanged'?'Context unchanged. Full history retained.':latest.status==='cancelled'?'Compaction cancelled.':latest.error||'Compaction could not finish.'}</p>}</details>}
        {error&&<div className="timber-memory-error" role="alert"><p>{error}</p>{retry?<><p>The result is unconfirmed. Retry this same request before making another change.</p><button type="button" className="quiet" disabled={busy} onClick={()=>void perform(retry)}>Retry request</button></>:<button type="button" className="quiet" onClick={()=>{setError('');void loadMemory().catch(reason=>setError(message(reason)));}}>Refresh memory</button>}</div>}
        {notice&&<p role="status" className="hint timber-memory-notice">{notice}{undo&&<button type="button" className="quiet" disabled={locked} onClick={()=>void perform(undo)}>Undo</button>}</p>}
        {memory&&<section aria-label="Durable memory">
          <div className="timber-memory-line"><strong>Remembered <small>{memory.entries.length} {memory.entries.length===1?'note':'notes'}</small></strong><button type="button" className="quiet" disabled={locked} onClick={()=>startEdit()}><PlusIcon aria-hidden="true"/>Add memory</button></div>
          <MemoryPreview key={botId} botId={botId} request={request} revision={memory.revision}/><div className="timber-memory-search"><SearchIcon aria-hidden="true"/><input type="search" aria-label="Search memory" placeholder="Search memory" maxLength={200} value={query} onChange={event=>setQuery(event.currentTarget.value)}/></div>
          {draft&&<form className="timber-memory-editor" aria-label={draft.id?'Edit memory':'Add memory'} onSubmit={event=>{event.preventDefault();if(locked||conflict)return;mutate(draft.id?`/memory/entries/${encodeURIComponent(draft.id)}`:'/memory/entries',draft.id?'PATCH':'POST',{...draft},'Memory saved.',true);}}>
            <label>Category<select aria-label="Memory category" value={draft.category} disabled={locked} onChange={event=>setDraft({...draft,category:event.currentTarget.value as MemoryCategory})}>{Object.entries(categories).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label>Title<input aria-label="Memory title" required maxLength={memory.limits.maxTitleCharacters} value={draft.title} disabled={locked} onChange={event=>setDraft({...draft,title:event.currentTarget.value})}/></label>
            <label>Note<textarea aria-label="Memory note" required maxLength={memory.limits.maxEntryCharacters} rows={3} value={draft.content} disabled={locked} onChange={event=>setDraft({...draft,content:event.currentTarget.value})}/></label>
            <label className="timber-memory-pin"><input type="checkbox" checked={draft.pinned} disabled={locked} onChange={event=>setDraft({...draft,pinned:event.currentTarget.checked})}/>Pin as a priority memory</label>
            {conflict&&<div role="status" className="timber-memory-conflict"><p>This note changed. Your draft is preserved.</p>{editing?<><p>Latest saved note: {editing.content}</p><button type="button" className="quiet" onClick={()=>{setDraft({...draft,expectedRevision:editing.revision});setConflict(false);setError('');}}>Use latest revision, keep my draft</button></>:<p>The note is no longer available. Copy your draft before closing.</p>}</div>}
            <div className="timber-memory-line"><small>{draft.content.length.toLocaleString()} / {memory.limits.maxEntryCharacters.toLocaleString()}</small><div className="timber-memory-buttons"><button type="button" className="quiet" disabled={locked} onClick={()=>{setDraft(undefined);setConflict(false);}}>Cancel</button><button type="submit" className="quiet" disabled={locked||conflict||!draft.title.trim()||!draft.content.trim()}>{busy?'Saving…':'Save memory'}</button></div></div>
          </form>}
          {searching&&<p role="status" className="hint">Searching…</p>}
          {!searching&&!entries.length&&<p className="hint">{query.trim()?'No matching memories.':'No memories yet. Add a note or review past messages.'}</p>}
          {(Object.keys(categories) as MemoryCategory[]).map(category=>{const group=entries.filter(entry=>entry.category===category);return group.length?<div key={category} className="timber-memory-group"><h3>{categories[category]}</h3>{group.map(entry=>note(entry,entry.state==='suggested'))}</div>:null;})}
          {results?.truncated&&<p className="hint">Showing the first {results.hits.length} matches. Refine your search for more.</p>}
          {!!memory.suggestions.length&&!query.trim()&&<div className="timber-memory-suggestions"><h3>Suggested changes <small>{memory.suggestions.length}</small></h3><p className="hint">Review these before they become active memory.</p>{memory.suggestions.map(entry=>note(entry,true))}</div>}
          <div className="timber-memory-review"><div className="timber-memory-line"><strong>Learn from history</strong><button type="button" className="quiet" disabled={locked||reviewing} onClick={()=>mutate('/memory/review','POST',{},'History review requested.')}>{reviewing?'Reviewing…':memory.review.hasMore?'Review more history':'Review history'}</button></div><p className="hint">Useful memories are learned automatically. Review also processes saved messages in batches.</p>{memory.review.status!=='idle'&&<p role={memory.review.status==='failed'?'alert':'status'} className={memory.review.status==='failed'?'timber-memory-error':'hint'} data-memory-review-status={memory.review.status}>{memory.review.status==='failed'?memory.review.error||'History review could not finish.':reviewing?'Reviewing saved messages…':`${memory.review.examinedMessages} messages reviewed · ${memory.review.added} notes added · ${memory.review.suggested} suggestions`}{memory.review.hasMore&&!reviewing?' · More history available.':''}</p>}</div>
          {memory.legacy&&<details className="timber-memory-legacy"><summary>Previous memory · archived</summary><p className="hint">Preserved for your review. This old text is not used as active memory. Add any useful facts as individual notes.</p><pre>{memory.legacy.content}</pre><LegacyExport content={memory.legacy.content} botId={botId}/></details>}
        </section>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
