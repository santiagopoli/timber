import {createElement,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {MonitorIcon,PlusIcon,RefreshCwIcon} from 'lucide-react';
import './devices.css';
import type {ExecutionTarget,DevicePermission} from '../../../packages/contracts/src/devices';
export type {ExecutionTarget,DevicePermission} from '../../../packages/contracts/src/devices';

export type Machine={id:string;name:string;online:boolean;status:string;capabilities:string[];workspaces:{id:string;name:string;path?:string;capabilities?:string[]}[];grants:{id?:string;botId:string;workspaceIds:string[];permissions:DevicePermission[]}[]};
export type DevicesRequest=(path:string,options?:{method?:string;body?:unknown;signal?:AbortSignal})=>Promise<unknown>;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const str=(value:unknown)=>typeof value==='string'?value:'';
const strings=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
const permissions:DevicePermission[]=['diagnostics','files.read','files.write','host.shell','agent.run'];
export function machinesFrom(value:unknown):Machine[]{
  const items=Array.isArray(value)?value:record(value)&&Array.isArray(value.devices)?value.devices:[];
  return items.filter(record).map(item=>({id:str(item.id),name:str(item.name)||'Machine',online:item.status!=='revoked'&&(item.online===true||item.status==='online'),status:str(item.status),capabilities:strings(item.capabilities),workspaces:(Array.isArray(item.workspaces)?item.workspaces:[]).filter(record).map(workspace=>({id:str(workspace.id),name:str(workspace.name)||str(workspace.id),path:str(workspace.path),capabilities:strings(workspace.capabilities)})),grants:(Array.isArray(item.grants)?item.grants:[]).filter(record).filter(grant=>!grant.revokedAt&&grant.status!=='revoked').map(grant=>({id:str(grant.id),botId:str(grant.botId),workspaceIds:strings(grant.workspaceIds),permissions:strings(grant.permissions).filter((permission):permission is DevicePermission=>permissions.includes(permission as DevicePermission))}))})).filter(item=>item.id);
}
export function targetFrom(value:unknown):ExecutionTarget|undefined{
  if(!record(value))return;if(value.kind==='cloud')return {kind:'cloud'};
  if(value.kind==='device'&&str(value.deviceId)&&str(value.workspaceId))return {kind:'device',deviceId:str(value.deviceId),workspaceId:str(value.workspaceId),agentMode:value.agentMode==='local'?'local':'cloud'};
}
export function targetLabel(target:ExecutionTarget|undefined,machines:Machine[]){
  if(!target||target.kind==='cloud')return 'Cloud';const machine=machines.find(item=>item.id===target.deviceId),workspace=machine?.workspaces.find(item=>item.id===target.workspaceId);
  return `${machine?.name||'Unavailable machine'} · ${workspace?.name||'Unavailable workspace'}${machine?.status==='revoked'?' · Revoked':machine?.online?'':' · Offline'}${target.agentMode==='local'?' · Local Pi':' · Cloud agent'}`;
}
export function ExecutionTargetPicker({value,onChange,machines,label='Execution location',inherit=false,inherited,botId}:{value?:ExecutionTarget;onChange:(value:ExecutionTarget|undefined)=>void;machines:Machine[];label?:string;inherit?:boolean;inherited?:ExecutionTarget;botId?:string}){
  const id=useId(),selected=value?.kind==='device'?JSON.stringify({kind:'device',deviceId:value.deviceId,workspaceId:value.workspaceId}):value?.kind==='cloud'?'cloud':inherit?'inherit':'cloud';
  const options=machines.filter(machine=>machine.status!=='revoked').flatMap(machine=>machine.workspaces.map(workspace=>({key:JSON.stringify({kind:'device',deviceId:machine.id,workspaceId:workspace.id}),name:`${machine.name} / ${workspace.name}${machine.online?'':' · Offline'}`})));
  const current=value?.kind==='device'?machines.find(machine=>machine.id===value.deviceId):undefined;
  const grant=current?.grants.find(grant=>grant.botId===botId&&value?.kind==='device'&&grant.workspaceIds.includes(value.workspaceId));
  const localCapable=value?.kind==='device'&&current?.workspaces.find(workspace=>workspace.id===value.workspaceId)?.capabilities?.includes('agent.run');
  const effective=value||inherited;
  return <div className="timber-target-picker"><label htmlFor={id}>{label}</label><select id={id} value={selected} onChange={event=>{const next=event.currentTarget.value;onChange(next==='inherit'?undefined:next==='cloud'?{kind:'cloud'}:{...JSON.parse(next),agentMode:'cloud'})}}>
    {inherit&&<option value="inherit">Use bot location · {targetLabel(inherited,machines)}</option>}<option value="cloud">Cloud</option>
    {value?.kind==='device'&&!options.some(option=>option.key===selected)&&<option value={selected}>Unavailable machine / workspace</option>}{options.map(option=><option key={option.key} value={option.key}>{option.name}</option>)}
  </select>{value?.kind==='device'&&<><label htmlFor={`${id}-mode`}>Agent location</label><select id={`${id}-mode`} value={value.agentMode||'cloud'} onChange={event=>onChange({...value,agentMode:event.currentTarget.value==='local'?'local':'cloud'})}><option value="cloud">Cloud agent · tools on machine</option><option value="local" disabled={!localCapable&&value.agentMode!=='local'}>Local Pi · agent on machine</option></select><p className="hint">Local Pi requires the runner’s agent capability and an explicit agent.run grant. Models and memory remain in Timber. Computer permission does not replace the machine’s explicit grants.</p>{!grant&&<p className="hint">Choose access for this bot in Settings → Machines before starting work. Selecting a location grants no permissions.</p>}</>}
    {effective?.kind==='device'&&<p className="hint" role="status">{targetLabel(effective,machines)}. Offline work waits for this machine; it does not move to Cloud.</p>}
  </div>;
}
export function mountExecutionTarget(container:HTMLElement,initial:{machines:Machine[];value?:ExecutionTarget;onChange:(value:ExecutionTarget|undefined)=>void;botId?:string}){
  const root=createRoot(container);let props=initial;const render=()=>root.render(<ExecutionTargetPicker {...props}/>);render();return {update(next:typeof initial){props=next;render()},unmount(){root.unmount()}};
}
const permissionName:Record<DevicePermission,string>={diagnostics:'Diagnostics', 'files.read':'Read files','files.write':'Write files','host.shell':'Run shell commands','agent.run':'Run local Pi'};
function DeviceCard({machine,bots,request,onChanged}:{machine:Machine;bots:{id:string;name:string}[];request:DevicesRequest;onChanged:()=>Promise<void>}){
  const [botId,setBotId]=useState(''),[workspaceIds,setWorkspaceIds]=useState<string[]>([]),[allowed,setAllowed]=useState<DevicePermission[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  const choose=(id:string)=>{setBotId(id);const grant=machine.grants.find(grant=>grant.botId===id);setWorkspaceIds(grant?.workspaceIds||[]);setAllowed(grant?.permissions||[])};
  const save=async(event:FormEvent)=>{event.preventDefault();if(!botId||!workspaceIds.length||!allowed.length||busy)return;setBusy(true);setError('');try{await request(`/v1/devices/${encodeURIComponent(machine.id)}/grants`,{method:'POST',body:{botId,workspaceIds,permissions:allowed}});await onChanged()}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not save machine access.')}finally{if(alive.current)setBusy(false)}};
  const revoke=async(grant:Machine['grants'][number])=>{if(busy)return;setBusy(true);setError('');try{await request(`/v1/devices/${encodeURIComponent(machine.id)}/grants/${encodeURIComponent(grant.botId)}`,{method:'DELETE'});await onChanged();if(alive.current&&botId===grant.botId){setAllowed([]);setWorkspaceIds([])}}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not revoke machine access.')}finally{if(alive.current)setBusy(false)}};
  const revokeMachine=async()=>{if(busy)return;setBusy(true);setError('');try{await request(`/v1/devices/${encodeURIComponent(machine.id)}`,{method:'DELETE'});await onChanged()}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not revoke this machine.')}finally{if(alive.current)setBusy(false)}};
  const names=new Map(bots.map(bot=>[bot.id,bot.name]));
  return <article className="timber-device-card" data-device-id={machine.id}><header><MonitorIcon/><strong>{machine.name}</strong><span className="status" data-device-status={machine.status==='revoked'?'revoked':machine.online?'online':'offline'}>{machine.status==='revoked'?'Revoked':machine.online?'Online':'Offline'}</span></header>
    <p className="hint">Capabilities: {[...new Set([...machine.capabilities,...machine.workspaces.flatMap(workspace=>workspace.capabilities||[])])].join(', ')||'Not reported'}</p><ul className="timber-device-workspaces">{machine.workspaces.map(workspace=><li key={workspace.id}><strong>{workspace.name}</strong>{workspace.path&&<code>{workspace.path}</code>}</li>)}</ul>
    {machine.grants.map(grant=><div className="timber-device-grant" key={grant.botId} data-device-grant-bot={grant.botId}><span>{names.get(grant.botId)||'Bot'} · {grant.permissions.map(permission=>permissionName[permission]).join(', ')}</span><button type="button" className="quiet" disabled={busy} onClick={()=>void revoke(grant)}>Revoke {names.get(grant.botId)||'bot'} access</button></div>)}
    {machine.status!=='revoked'&&<><details><summary>Choose bot access</summary><form onSubmit={event=>void save(event)}><label>Bot<select aria-label="Bot" value={botId} onChange={event=>choose(event.currentTarget.value)} required><option value="">Choose a bot</option>{bots.map(bot=><option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <fieldset><legend>Workspaces</legend>{machine.workspaces.map(workspace=><label className="timber-device-check" key={workspace.id}><input type="checkbox" checked={workspaceIds.includes(workspace.id)} onChange={event=>{const checked=event.currentTarget.checked;setWorkspaceIds(previous=>checked?[...previous,workspace.id]:previous.filter(id=>id!==workspace.id))}}/>{workspace.name}</label>)}</fieldset>
      <fieldset><legend>Permissions</legend>{permissions.map(permission=><label className="timber-device-check" key={permission}><input type="checkbox" checked={allowed.includes(permission)} onChange={event=>{const checked=event.currentTarget.checked;setAllowed(previous=>checked?[...previous,permission]:previous.filter(item=>item!==permission))}}/>{permissionName[permission]}</label>)}</fieldset>
      <p className="hint">Shell commands run with your user’s privileges. The workspace folder sets the working directory; it is not a sandbox. Grant host.shell only when you intend to allow that access.</p>
      <button type="submit" disabled={busy||!botId||!workspaceIds.length||!allowed.length}>{busy?'Saving…':'Save machine access'}</button></form></details><button type="button" className="quiet timber-device-revoke" disabled={busy} onClick={()=>void revokeMachine()}>Revoke machine</button></>}{error&&<p className="error" role="alert">{error}</p>}
  </article>;
}
type SettingsProps={request:DevicesRequest;bots:{id:string;name:string}[];machines:Machine[];active:boolean;onChanged:()=>Promise<void>;error?:string;loading?:boolean};
function DevicesSettings({props}:{props:SettingsProps}){
  const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);useEffect(()=>{if(!props.active){setCode('');setError('')}},[props.active]);
  useEffect(()=>{if(!props.active||props.loading)return;const timer=setInterval(()=>{if(!document.hidden)void props.onChanged()},8000);return()=>clearInterval(timer)},[props.active,props.loading,props.onChanged]);
  const pair=async(event:FormEvent)=>{event.preventDefault();if(!code.trim()||busy)return;setBusy(true);setError('');try{await props.request('/v1/devices/pairings/approve',{method:'POST',body:{code:code.trim()}});if(alive.current)setCode('');await props.onChanged()}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not pair this machine.')}finally{if(alive.current)setBusy(false)}};
  return <section className="timber-devices" aria-label="Machines"><div className="section-title"><h3>Machines</h3><button type="button" className="quiet" aria-label="Refresh machines" onClick={()=>void props.onChanged()} disabled={props.loading}><RefreshCwIcon/>Refresh</button></div>
    <p className="hint">Run the Timber runner on your machine and enter its one-time pairing code. Pairing registers its identity; bots receive access only through the grants below.</p>
    <form className="timber-device-pair" onSubmit={event=>void pair(event)}><label htmlFor="device-pair-code">Pairing code</label><div className="row"><input id="device-pair-code" value={code} maxLength={80} autoComplete="off" spellCheck={false} onChange={event=>setCode(event.currentTarget.value)} placeholder="One-time code"/><button type="submit" disabled={busy||!code.trim()}><PlusIcon/>{busy?'Pairing…':'Pair machine'}</button></div></form>
    {(error||props.error)&&<p className="error" role="alert">{error||props.error}</p>}{props.loading&&!props.machines.length&&<p className="hint" role="status">Loading machines…</p>}{!props.loading&&!props.machines.length&&<p className="hint">No paired machines.</p>}
    {props.machines.map(machine=><DeviceCard key={machine.id} machine={machine} bots={props.bots} request={props.request} onChanged={props.onChanged}/>)}</section>;
}
export function mountDevices(container:HTMLElement,props:SettingsProps){const root=createRoot(container);root.render(createElement(DevicesSettings,{props}));return {update(next:SettingsProps){root.render(createElement(DevicesSettings,{props:next}))},unmount(){root.unmount()}}}
