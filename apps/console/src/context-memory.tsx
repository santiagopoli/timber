import {useEffect,useRef,useState} from 'react';
import {Dialog} from 'radix-ui';
import {BrainIcon,LoaderCircleIcon,XIcon} from 'lucide-react';
import type {BotContextStatus,BotMemory,CompactionReceipt} from '../../../packages/contracts/src/index';
import './context-memory.css';

export type ContextMemoryRequest=(botId:string,path:string,options?:{method?:string;body?:unknown;signal?:AbortSignal})=>Promise<unknown>;

export function ContextMemoryControl({botId,request,refreshKey}: {botId:string;request:ContextMemoryRequest;refreshKey?:string|number}) {
  const [open,setOpen]=useState(false),[context,setContext]=useState<BotContextStatus>(),[memory,setMemory]=useState<BotMemory>();
  const [draft,setDraft]=useState(''),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[compacting,setCompacting]=useState(false);
  const [error,setError]=useState(''),[memoryError,setMemoryError]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef<{botId:string;operationId:string}|undefined>(undefined),currentBot=useRef(botId),epoch=useRef(0);currentBot.current=botId;
  const loadMemory=async(signal?:AbortSignal)=>{
    const scope=epoch.current,result=await request(botId,'/memory',{signal}) as {memory:BotMemory};
    if(signal?.aborted||currentBot.current!==botId||scope!==epoch.current)return;
    setMemory(result.memory);setDraft(result.memory.content);setMemoryError('');
  };
  const loadContext=async(signal?:AbortSignal)=>{
    const scope=epoch.current,result=await request(botId,'/context',{signal}) as {context:BotContextStatus};
    if(signal?.aborted||currentBot.current!==botId||scope!==epoch.current)return;
    setContext(result.context);
  };
  useEffect(()=>{
    epoch.current++;setSaving(false);setCompacting(false);setContext(undefined);setMemory(undefined);setDraft('');setError('');setNotice('');setMemoryError('');
    if(!open)return;
    const controller=new AbortController();setLoading(true);
    void Promise.all([loadContext(controller.signal),loadMemory(controller.signal)]).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Could not load context and memory.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[botId,open]);
  const running=Boolean(context?.compactions.some(item=>item.status==='running'));
  useEffect(()=>{
    if(!open||!running)return;
    const controller=new AbortController();
    const timer=setInterval(()=>{void loadContext(controller.signal).catch(()=>{if(!controller.signal.aborted)setError('Could not refresh compaction status. Close and reopen to check it.');});},2000);
    return()=>{clearInterval(timer);controller.abort();};
  },[botId,open,running]);
  const compact=async()=>{
    if(compacting||running)return;
    const scope=epoch.current,operation=pending.current?.botId===botId?pending.current:{botId,operationId:crypto.randomUUID()};pending.current=operation;
    setCompacting(true);setError('');setNotice('');
    try {
      const result=await request(botId,'/context/compact',{method:'POST',body:{operationId:operation.operationId}}) as {compaction:CompactionReceipt};
      if(currentBot.current!==botId||scope!==epoch.current)return;
      pending.current=undefined;
      setNotice(result.compaction.status==='unchanged'?'No context changes were needed. Your full history is retained.':'Compaction requested. Your full conversation stays available.');
      await loadContext();
    } catch(reason) {if(currentBot.current===botId&&scope===epoch.current)setError(reason instanceof Error?reason.message:'Compaction could not be confirmed. Try again.');}
    finally {if(currentBot.current===botId&&scope===epoch.current)setCompacting(false);}
  };
  const save=async()=>{
    if(!memory||saving)return;
    const scope=epoch.current;setSaving(true);setMemoryError('');setNotice('');
    try {
      const result=await request(botId,'/memory',{method:'PUT',body:{content:draft,revision:memory.revision}}) as {memory:BotMemory};
      if(currentBot.current!==botId||scope!==epoch.current)return;
      setMemory(result.memory);setDraft(result.memory.content);setNotice('Memory saved.');
    } catch(reason) {if(currentBot.current===botId&&scope===epoch.current)setMemoryError(reason instanceof Error?reason.message:'Memory could not be saved. Your draft is still here.');}
    finally {if(currentBot.current===botId&&scope===epoch.current)setSaving(false);}
  };
  const latest=context?.compactions[0];
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="timber-memory-trigger" aria-label="Context and memory"><BrainIcon aria-hidden="true"/><span>Context</span></button></Dialog.Trigger>
    <Dialog.Portal container={document.fullscreenElement||document.body}>
      {open&&<div className="timber-memory-overlay" aria-hidden="true"/>}
      <Dialog.Content className="timber-memory-dialog">
        <div className="timber-memory-heading"><Dialog.Title>Context and memory</Dialog.Title><Dialog.Close className="quiet icon-button" aria-label="Close context and memory"><XIcon aria-hidden="true"/></Dialog.Close></div>
        <Dialog.Description>Older context is summarized automatically. Your full conversation history stays saved.</Dialog.Description>
        {loading&&<p role="status"><LoaderCircleIcon className="timber-spinner"/>Loading…</p>}
        {context&&<section aria-label="Conversation context">
          <div className="timber-memory-line"><span>Active context · about {context.estimatedTokens.toLocaleString()} tokens</span><button type="button" className="quiet" disabled={compacting||running} onClick={()=>void compact()}>{compacting||running?<><LoaderCircleIcon className="timber-spinner"/>Compacting…</>:'Compact now'}</button></div>
          <p className="hint">{context.contextWindow.toLocaleString()} token model window. Recent messages remain in context.</p>
          {latest&&<p role="status" data-compaction-status={latest.status}>{latest.status==='running'?'Summarizing older context…':latest.status==='completed'?'Context compacted. Full history retained.':latest.status==='unchanged'?'Context unchanged. Full history retained.':latest.status==='cancelled'?'Compaction cancelled.':latest.error||'Compaction could not finish.'}</p>}
        </section>}
        {error&&<p className="timber-memory-error" role="alert">{error}</p>}
        {memory&&<section aria-label="Durable memory">
          <label htmlFor="timber-memory-notes"><strong>Durable notes</strong></label>
          <p className="hint">Preferences, project facts and decisions this bot should remember. You and the bot can edit these notes. Subagents keep separate notes.</p>
          <textarea id="timber-memory-notes" aria-label="Durable notes" value={draft} maxLength={memory.maxCharacters} onChange={event=>setDraft(event.currentTarget.value)} rows={8}/>
          <div className="timber-memory-line"><small>{draft.length.toLocaleString()} / {memory.maxCharacters.toLocaleString()} characters</small><button type="button" className="quiet" disabled={saving||draft===memory.content} onClick={()=>void save()}>{saving?'Saving…':'Save notes'}</button></div>
          {memoryError&&<div className="timber-memory-error" role="alert"><p>{memoryError}</p><button type="button" className="quiet" onClick={()=>void loadMemory().catch(reason=>setMemoryError(reason instanceof Error?reason.message:'Could not reload memory.'))}>Reload saved notes</button></div>}
        </section>}
        {notice&&<p role="status" className="hint">{notice}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
