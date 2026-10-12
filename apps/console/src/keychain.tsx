import {createContext,useContext,useCallback,useEffect,useRef,useState,type ReactNode,type FormEvent} from 'react';
import {Dialog} from 'radix-ui';
import {KeyRoundIcon,LockKeyholeIcon,PencilIcon,PlusIcon,ShieldCheckIcon,XIcon} from 'lucide-react';
import type {SecretMetadata,SecureInputRequest} from '../../../packages/contracts/src/index';
import type {ContextMemoryRequest} from './context-memory';
import './keychain.css';

type Draft=Partial<SecretMetadata>;
type State={entries:SecretMetadata[];requests:SecureInputRequest[];error:string;loading:boolean;refresh:()=>Promise<void>;botId:string;botName:string;permission:(id:string,botId:string,allowed:boolean)=>Promise<void>;rename:(id:string,name:string,revision:number,operationId:string)=>Promise<void>;save:(body:unknown)=>Promise<SecretMetadata[]>;authorize:(id:string)=>Promise<void>;revoke:(id:string)=>Promise<void>};
const Context=createContext<State|null>(null);
export function useKeychain(){const value=useContext(Context);if(!value)throw new Error('Keychain provider is missing');return value;}
const failure=(reason:unknown)=>{
  const code=(reason as {code?:string})?.code;
  const messages:Record<string,string>={invalid_secure_input:'This input could not be saved. Check its length and try again.',invalid_request:'Enter up to 16,000 characters.',credential_changed:'This input changed or was removed. Select its latest version in the keychain.',secure_input_inactive:'This request is no longer active.',keychain_unavailable:'Secure storage is unavailable. Nothing was saved.',keychain_full:'Your keychain is full. Remove an unused input first.'};
  return new Error(messages[code??'']??'Save could not be confirmed. Check the keychain before entering the value again.');
};
export function KeychainProvider({children,botId,botName,request,refreshKey}:{children:ReactNode;botId:string;botName:string;request:ContextMemoryRequest;refreshKey?:number|string}) {
  const [entries,setEntries]=useState<SecretMetadata[]>([]),[requests,setRequests]=useState<SecureInputRequest[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const alive=useRef(true),sequence=useRef(0),controller=useRef(new AbortController());
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current.abort();};},[]);
  const refresh=useCallback(async()=>{
    const current=++sequence.current;
    try{const result=await request(botId,'/keychain',{signal:controller.current.signal}) as {entries:SecretMetadata[];requests:SecureInputRequest[]};if(!alive.current||current!==sequence.current)return;if(!Array.isArray(result.entries)||!Array.isArray(result.requests))throw new Error('Unavailable');setEntries(result.entries);setRequests(result.requests);setError('');}
    catch{if(alive.current&&current===sequence.current)setError('Keychain could not be loaded. Try refreshing.');}
    finally{if(alive.current&&current===sequence.current)setLoading(false);}
  },[botId,request]);
  useEffect(()=>{void refresh();},[refresh,refreshKey]);
  const save=async(body:unknown)=>{
    try{const result=await request(botId,'/keychain',{method:'POST',body,signal:controller.current.signal}) as {entries:SecretMetadata[]};if(!alive.current)throw new Error('Inactive');await refresh();return result.entries;}
    catch(reason){await refresh();throw failure(reason);}
  };
  const permission=async(id:string,target:string,allowed:boolean)=>{try{await request(botId,`/keychain/${encodeURIComponent(id)}/permissions`,{method:'POST',body:{botId:target,allowed},signal:controller.current.signal});await refresh();}catch{throw new Error('Access could not be updated. Refresh the keychain.');}};
  const rename=async(id:string,name:string,revision:number,operationId:string)=>{
    try{await request(botId,`/keychain/${encodeURIComponent(id)}`,{method:'PATCH',body:{name,expectedRevision:revision,operationId},signal:controller.current.signal});await refresh();}
    catch(reason){await refresh();const code=(reason as {code?:string})?.code;throw new Error(code==='credential_changed'?'This input changed. Cancel and rename its latest version.':code==='invalid_secure_input'||code==='invalid_request'?'Use a name between 1 and 80 characters.':'The name could not be saved. Try again.');}
  };
  const authorize=async(id:string)=>{try{await request(botId,`/keychain/requests/${encodeURIComponent(id)}/authorize`,{method:'POST',body:{},signal:controller.current.signal});await refresh();}catch(reason){await refresh();throw failure(reason);}};
  const revoke=async(id:string)=>{try{await request(botId,`/keychain/${encodeURIComponent(id)}`,{method:'DELETE',signal:controller.current.signal});await refresh();}catch{throw new Error('Removal could not be confirmed. Refresh the keychain.');}};
  return <Context.Provider value={{entries,requests,error,loading,refresh,botId,botName,save,authorize,revoke,permission,rename}}>{children}</Context.Provider>;
}

function SecureInputForm({initial,requestId,onSaved}:{initial:Draft[];requestId?:string;onSaved?:(entries:SecretMetadata[])=>void}) {
  const {save}=useKeychain(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const form=useRef<HTMLFormElement>(null),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;if(form.current)for(const input of form.current.querySelectorAll<HTMLTextAreaElement>('[data-secure-value]'))input.value='';},[]);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;
    const node=event.currentTarget,data=new FormData(node);
    const entries=initial.map((item,index)=>({...(item.id?{id:item.id,expectedRevision:item.revision}:{}),...(item.name?{name:item.name}:{}),value:String(data.get(`value-${index}`))}));
    // Private text exists only in masked DOM inputs and this authenticated write.
    // The composer, state, browser storage and delivery retries receive references.
    for(const input of node.querySelectorAll<HTMLTextAreaElement>('[data-secure-value]'))input.value='';
    setBusy(true);setError('');
    try{const saved=await save({operationId:crypto.randomUUID(),entries,...(requestId?{requestId}:{})});if(alive.current)onSaved?.(saved);}
    catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'The secure submission could not be confirmed.');}
    finally{entries.forEach(entry=>{entry.value='';});if(alive.current)setBusy(false);}
  }
  return <form ref={form} className="timber-secure-form" onSubmit={submit} autoComplete="off">
    {initial.map((item,index)=><label key={index}>{initial.length>1?`Private input ${index+1}`:'Private text'}<textarea name={`value-${index}`} aria-label={`Private input ${index+1}`} className="timber-private-text" rows={2} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={16_000} required disabled={busy} placeholder="Paste here" data-secure-value/></label>)}
    {error&&<p role="alert" className="timber-secure-error">{error}</p>}
    <div className="timber-secure-actions"><button type="submit" className="primary" disabled={busy}>{busy?'Saving…':requestId?'Save & continue':initial[0]?.id?'Save replacement':'Insert'}</button></div>
  </form>;
}
const destination=(origin:string)=>{try{return new URL(origin).hostname;}catch{return '';}};
export function SecureRequestCard({item,onStop}:{item:SecureInputRequest;onStop:()=>void}) {
  const {authorize,botName}=useKeychain(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <section className="timber-secure-card" data-secure-request={item.id} aria-label={`Secure input: ${item.name}`}>
    {item.status==='pending'?<><div className="timber-secure-title"><LockKeyholeIcon/><strong>{item.name}</strong></div><p className="timber-secure-purpose">{item.secretId?`Allow ${botName} to use this input with ${destination(item.origin)}?`:item.purpose}</p>{item.secretId?<><div className="timber-secure-actions"><button type="button" className="primary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await authorize(item.id);}catch(reason){setError(reason instanceof Error?reason.message:'Could not confirm access.');}finally{setBusy(false);}}}>{busy?'Allowing…':'Allow use'}</button></div>{error&&<p role="alert" className="timber-secure-error">{error}</p>}</>:<>{item.origin&&<p className="timber-secure-hint">For {destination(item.origin)}</p>}<SecureInputForm initial={[{name:item.name}]} requestId={item.id}/></>}<button type="button" className="quiet timber-secure-stop" disabled={busy} onClick={onStop}>Decline and stop this task</button></>:<details className="timber-secure-receipt"><summary><ShieldCheckIcon/>{item.name}<span>{item.status==='saved'?(item.secretId?'Access allowed':'Saved securely'):'Request cancelled'}</span></summary><p>{item.purpose}</p></details>}
  </section>;
}
export function SecureSavedPill({names}:{names:string[]}){return <div className="timber-secure-saved"><ShieldCheckIcon/><span>Saved securely{names.some(name=>name!=='Private input')?` · ${names.join(', ')}`:''}</span></div>;}

function KeychainName({item,disabled,onBusy}:{item:SecretMetadata;disabled:boolean;onBusy:(busy:boolean)=>void}) {
  const {rename}=useKeychain(),[draft,setDraft]=useState<{name:string;revision:number;operationId:string}|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  if(!draft)return <button type="button" className="timber-keychain-name" aria-label={`Rename ${item.name}`} title="Rename" disabled={disabled} onClick={()=>{setDraft({name:item.name==='Private input'?'':item.name,revision:item.revision,operationId:crypto.randomUUID()});setError('');}}><strong>{item.name}</strong><PencilIcon aria-hidden="true"/></button>;
  return <form className="timber-keychain-name-form" onSubmit={async event=>{
    event.preventDefault();if(saving||disabled||!draft.name.trim())return;setSaving(true);onBusy(true);setError('');
    try{await rename(item.id,draft.name.trim(),draft.revision,draft.operationId);setDraft(null);}catch(reason){setError(reason instanceof Error?reason.message:'The name could not be saved.');}finally{setSaving(false);onBusy(false);}
  }}><label><span className="sr-only">Name</span><input aria-label="Name" autoFocus autoComplete="off" placeholder="e.g. Cloudflare API key" maxLength={80} required disabled={disabled||saving} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value,operationId:crypto.randomUUID()})} onKeyDown={event=>{if(event.key==='Escape'&&!saving){event.preventDefault();event.stopPropagation();setDraft(null);}}}/></label><div className="timber-secure-actions"><button type="submit" className="primary" disabled={disabled||saving||!draft.name.trim()}>{saving?'Saving…':'Save name'}</button><button type="button" className="quiet" disabled={saving} onClick={()=>setDraft(null)}>Cancel</button></div>{error&&<p role="alert" className="timber-secure-error">{error}</p>}</form>;
}

export function KeychainControl({onInsert,onAdd,onReplace,bots}:{onInsert:(entries:SecretMetadata[])=>void;onAdd:()=>void;onReplace:(entry:SecretMetadata)=>void;bots:{id:string;name:string}[]}){
  const {entries,error,loading,refresh,botId,revoke,permission}=useKeychain(),[open,setOpen]=useState(false),[busy,setBusy]=useState(''),[failure,setFailure]=useState(''),[confirm,setConfirm]=useState('');
  // Create/focus composer content after the modal releases its focus scope.
  const afterClose=useRef<(()=>void)|undefined>(undefined);
  const closeFor=(action:()=>void)=>{afterClose.current=action;setOpen(false);};
  const access=async(id:string,target:string,allowed:boolean)=>{setBusy(id);setFailure('');try{await permission(id,target,allowed);}catch(reason){setFailure(reason instanceof Error?reason.message:'Could not update access.');}finally{setBusy('');}};
  return <Dialog.Root open={open} onOpenChange={value=>{setOpen(value);setConfirm('');if(value)void refresh();}}><Dialog.Trigger asChild><button className="timber-keychain-trigger" type="button" aria-label="Your keychain"><KeyRoundIcon/>Keychain</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="timber-memory-overlay"/><Dialog.Content className="timber-memory-dialog timber-keychain-dialog" onCloseAutoFocus={event=>{const action=afterClose.current;if(action){afterClose.current=undefined;event.preventDefault();action();}}}><div className="timber-secure-title"><Dialog.Title>Your keychain</Dialog.Title><Dialog.Close asChild><button className="quiet" aria-label="Close keychain"><XIcon/></button></Dialog.Close></div><Dialog.Description>Your private inputs. You choose which bots can use them.</Dialog.Description>
    <div className="timber-secure-actions"><button type="button" className="quiet" onClick={()=>closeFor(onAdd)}><PlusIcon/>Add secure input</button><button type="button" className="quiet" disabled={loading} onClick={()=>void refresh()}>Refresh</button></div>
    {(error||failure)&&<p role="alert" className="timber-secure-error">{error||failure}</p>}{loading?<p>Loading keychain…</p>:!entries.length&&!error?<p>No private inputs saved.</p>:null}
    {entries.map(item=><article className="timber-keychain-entry" key={item.id}><KeychainName item={item} disabled={!!busy} onBusy={value=>setBusy(value?item.id:'')}/>{item.origin&&<p>{destination(item.origin)}</p>}<small>{item.lastUsedAt?`Last used ${new Date(item.lastUsedAt).toLocaleString()}`:`Saved ${new Date(item.createdAt).toLocaleString()}`}</small><div className="timber-secure-actions"><button type="button" className="quiet" disabled={!!busy} onClick={async()=>{setBusy(item.id);setFailure('');try{if(!item.botIds?.includes(botId))await permission(item.id,botId,true);closeFor(()=>onInsert([item]));}catch{setFailure('Access could not be confirmed. Refresh and try again.');}finally{setBusy('');}}}>{item.botIds?.includes(botId)?'Insert':'Allow & insert'}</button><button type="button" className="quiet" disabled={!!busy} onClick={()=>closeFor(()=>onReplace(item))}>Replace</button><button type="button" className="quiet" disabled={!!busy} onClick={()=>setConfirm(item.id)}>Remove</button></div><details className="timber-keychain-permissions"><summary>Bots with access · {item.botIds?.length??0}</summary>{bots.map(bot=><label key={bot.id}><input type="checkbox" checked={item.botIds?.includes(bot.id)??false} disabled={!!busy} onChange={event=>void access(item.id,bot.id,event.target.checked)}/>{bot.name}</label>)}</details>{confirm===item.id&&<div className="timber-keychain-confirm"><p>Remove {item.name} from your keychain? All bots will lose access.</p><button type="button" className="quiet" disabled={!!busy} onClick={async()=>{setBusy(item.id);setFailure('');try{await revoke(item.id);setConfirm('');}catch(reason){setFailure(reason instanceof Error?reason.message:'Removal failed.');}finally{setBusy('');}}}>{busy===item.id?'Removing…':'Confirm removal'}</button><button type="button" className="quiet" disabled={!!busy} onClick={()=>setConfirm('')}>Keep input</button></div>}</article>)}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
