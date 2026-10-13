import {useState} from 'react';
import {Popover} from 'radix-ui';
import {ChevronDownIcon, LoaderCircleIcon, XIcon, ZapIcon} from 'lucide-react';
import type {ModelSettings as InferenceSettings} from '../../../packages/contracts/src/index';
import './model-settings.css';
import {ModelPickerContent} from './model-picker';
import type {ModelUsage} from './model-billing';
import {ModelBillingDetails} from './model-billing-details';

export type ModelChoice = {
  id:string;label:string;available:boolean;unavailableReason?:string;sourceLabel?:string;providerLabel?:string;
  usage?:ModelUsage;
  reasoningEfforts:string[];defaultReasoningEffort?:string;supportsFast:boolean;
};
export type ModelSelection = InferenceSettings;
export type ModelSettingsState = {choices:ModelChoice[];loading:boolean;error?:string;message?:string};
const effortLabel=(value:string)=>value==='xhigh'?'Extra high':value==='none'?'Off':value.replace(/^./,first=>first.toUpperCase());
const shortEffortLabel=(value:string)=>value==='minimal'?'Min':value==='medium'?'Med':value==='xhigh'?'X-high':effortLabel(value);

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
    if(id===value.model)return;
    const choice=state.choices.find(item=>item.id===id);if(!choice?.available)return;
    const reasoningEffort=value.reasoningEffort&&choice.reasoningEfforts.includes(value.reasoningEffort)?value.reasoningEffort:choice.defaultReasoningEffort;
    void update({model:id,...(reasoningEffort?{reasoningEffort}:{}),fast:Boolean(value.fast&&choice.supportsFast)});
  };
  return <div className="timber-model-settings">
    <Popover.Root open={open} onOpenChange={value=>{setOpen(value);if(value)onRefresh();}}>
      <Popover.Trigger asChild><button type="button" className="timber-model-trigger" aria-label={`Model settings: ${current?.label||value.model}`} title={`${value.model}${value.reasoningEffort?` · ${effortLabel(value.reasoningEffort)} reasoning`:''}${value.fast?' · Fast':''}`}>
        <span>{current?.label||value.model}</span>{value.reasoningEffort&&<small>{effortLabel(value.reasoningEffort)}</small>}{value.fast&&<ZapIcon aria-label="Fast mode"/>}{saving?<LoaderCircleIcon className="timber-spinner" aria-label="Saving model settings"/>:<ChevronDownIcon aria-hidden="true"/>}
      </button></Popover.Trigger>
      <Popover.Portal container={document.fullscreenElement||document.body}>
        <Popover.Content className="timber-model-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="Model settings">
          <ModelPickerContent value={value.model} choices={state.choices} disabled={disabled||saving||!state.choices.some(choice=>choice.available)} loading={state.loading} settings={value} close={<Popover.Close className="timber-model-picker-close" aria-label="Close model settings"><XIcon aria-hidden="true"/></Popover.Close>} onChange={selectModel}/>
          <div className="timber-model-options">
          <div className="timber-model-current"><span><small>{current?.reasoningEfforts.length?'Reasoning':'Selected model'}</small><strong>{current?.label||value.model}</strong></span>
          {current?.supportsFast&&<label className="timber-model-fast"><ZapIcon aria-hidden="true"/><span>Fast</span><input type="checkbox" role="switch" aria-label="Fast mode" checked={Boolean(value.fast)} disabled={disabled||saving||!current.available} onChange={event=>void update({...value,fast:event.currentTarget.checked})}/></label>}
          </div>
          {state.loading&&<p className="timber-model-help" role="status"><LoaderCircleIcon className="timber-spinner"/>Loading models…</p>}
          {state.message&&<p className="timber-model-help">{state.message}</p>}
          {state.error&&<div className="timber-model-error" role="alert"><p>{state.error}</p><button type="button" onClick={onRefresh}>Try again</button></div>}
          {current?.unavailableReason&&<p className="timber-model-help">{current.unavailableReason}</p>}
          {Boolean(current?.reasoningEfforts.length)&&<div className="timber-model-field"><div className="timber-model-efforts" role="group" aria-label="Reasoning effort">
            {current?.reasoningEfforts.map(effort=><button key={effort} type="button" aria-label={effortLabel(effort)} aria-pressed={effort===(value.reasoningEffort||current.defaultReasoningEffort)} disabled={disabled||saving||!current.available} onClick={()=>void update({...value,reasoningEffort:effort})}>{shortEffortLabel(effort)}</button>)}
          </div></div>}
          <ModelBillingDetails key={value.model} usage={current?.usage} settings={value}/>
          {error&&<p className="timber-model-error" role="alert">{error}</p>}
          {saving&&<p className="timber-model-help" role="status">Saving…</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
