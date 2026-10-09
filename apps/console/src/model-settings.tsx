import {useState} from 'react';
import {Popover} from 'radix-ui';
import {ChevronDownIcon, LoaderCircleIcon, XIcon, ZapIcon} from 'lucide-react';
import type {ModelSettings as InferenceSettings} from '../../../packages/contracts/src/index';
import './model-settings.css';

export type ModelChoice = {
  id:string;label:string;available:boolean;unavailableReason?:string;
  reasoningEfforts:string[];defaultReasoningEffort?:string;supportsFast:boolean;
};
export type ModelSelection = InferenceSettings;
export type ModelSettingsState = {choices:ModelChoice[];loading:boolean;error?:string;message?:string};
const effortLabel=(value:string)=>value==='xhigh'?'Extra high':value==='none'?'Off':value.replace(/^./,first=>first.toUpperCase());

export function ModelSettings({value,state,onChange,onRefresh,disabled=false}: {value:ModelSelection;state:ModelSettingsState;onChange(value:ModelSelection):Promise<void>;onRefresh():void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const current=state.choices.find(choice=>choice.id===value.model);
  const update=async(next:ModelSelection)=>{
    if(saving||disabled)return;
    setSaving(true);setError('');
    try{await onChange({model:next.model,...(next.reasoningEffort!==undefined?{reasoningEffort:next.reasoningEffort}:{}),...(next.fast!==undefined?{fast:next.fast}:{})});}catch(reason){setError(reason instanceof Error?reason.message:'Could not update the model. Try again.');}
    finally{setSaving(false);}
  };
  const selectModel=(id:string)=>{
    const choice=state.choices.find(item=>item.id===id);if(!choice?.available)return;
    const reasoningEffort=value.reasoningEffort&&choice.reasoningEfforts.includes(value.reasoningEffort)?value.reasoningEffort:choice.defaultReasoningEffort;
    void update({model:id,...(reasoningEffort?{reasoningEffort}:{}),fast:Boolean(value.fast&&choice.supportsFast)});
  };
  return <div className="timber-model-settings">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="timber-model-trigger" aria-label={`Model settings: ${current?.label||value.model}`} title={`${value.model}${value.reasoningEffort?` · ${effortLabel(value.reasoningEffort)} reasoning`:''}${value.fast?' · Fast':''}`}>
        <span>{current?.label||value.model}</span>{value.reasoningEffort&&<small>{effortLabel(value.reasoningEffort)}</small>}{value.fast&&<ZapIcon aria-label="Fast mode"/>}{saving?<LoaderCircleIcon className="timber-spinner" aria-label="Saving model settings"/>:<ChevronDownIcon aria-hidden="true"/>}
      </button></Popover.Trigger>
      <Popover.Portal container={document.fullscreenElement||document.body}>
        <Popover.Content className="timber-model-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="Model settings">
          <div className="timber-model-heading"><strong>Model settings</strong><Popover.Close aria-label="Close model settings"><XIcon aria-hidden="true"/></Popover.Close></div>
          <p className="timber-model-caption">Default for new messages and subagents.</p>
          {state.loading&&<p className="timber-model-help" role="status"><LoaderCircleIcon className="timber-spinner"/>Loading available models…</p>}
          {state.message&&<p className="timber-model-help">{state.message}</p>}
          {state.error&&<div className="timber-model-error" role="alert"><p>{state.error}</p><button type="button" onClick={onRefresh}>Try again</button></div>}
          <label className="timber-model-field">Model<select aria-label="Model" value={value.model} disabled={disabled||saving||state.loading||!state.choices.some(choice=>choice.available)} onChange={event=>selectModel(event.currentTarget.value)}>
            {!current&&<option value={value.model}>{value.model}</option>}
            {state.choices.map(choice=><option key={choice.id} value={choice.id} disabled={!choice.available}>{choice.label}{choice.available?'':' · Unavailable'}</option>)}
          </select></label>
          {current?.unavailableReason&&<p className="timber-model-help">{current.unavailableReason}</p>}
          {Boolean(current?.reasoningEfforts.length)&&<label className="timber-model-field">Reasoning<select aria-label="Reasoning effort" value={value.reasoningEffort||current?.defaultReasoningEffort||''} disabled={disabled||saving||!current?.available} onChange={event=>void update({...value,reasoningEffort:event.currentTarget.value})}>
            {!value.reasoningEffort&&!current?.defaultReasoningEffort&&<option value="" disabled>Provider default</option>}
            {current?.reasoningEfforts.map(effort=><option key={effort} value={effort}>{effortLabel(effort)}</option>)}
          </select></label>}
          {current?.supportsFast&&<label className="timber-model-fast"><span><ZapIcon aria-hidden="true"/><strong>Fast mode</strong></span><input type="checkbox" role="switch" aria-label="Fast mode" checked={Boolean(value.fast)} disabled={disabled||saving||!current.available} onChange={event=>void update({...value,fast:event.currentTarget.checked})}/></label>}
          {error&&<p className="timber-model-error" role="alert">{error}</p>}
          {saving&&<p className="timber-model-help" role="status">Saving…</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
