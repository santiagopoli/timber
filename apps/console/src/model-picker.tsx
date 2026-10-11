import {useEffect, useRef, useState,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {Popover} from 'radix-ui';
import {Command} from 'cmdk';
import {ArrowLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon, XIcon, ZapIcon} from 'lucide-react';
import './model-picker.css';
import {modelBillingView, type ModelUsage} from './model-billing';
import {ModelBillingDetails} from './model-billing-details';
import type {ModelSettings} from '../../../packages/contracts/src/models';

export type PickerChoice = {
  id:string;label:string;available:boolean;unavailableReason?:string;
  providerLabel?:string;sourceLabel?:string;supportsFast?:boolean;
  usage?:ModelUsage;reasoningEfforts?:string[];defaultReasoningEffort?:string;
  /** Unavailable avatar models can still be saved as theme configuration. */
  selectable?:boolean;
};
type PickerProps = {
  id?:string;value:string;choices:PickerChoice[];disabled?:boolean;loading?:boolean;
  settings?:ModelSettings;
  onChange(value:string):void;
};

/** Provider and model navigation, embedded in the caller's single popover. */
export function ModelPickerContent({value,choices,disabled=false,loading=false,settings,onChange,close}:Omit<PickerProps,'id'>&{close?:ReactNode}) {
  const [query,setQuery]=useState(''),[provider,setProvider]=useState<string|null>(null);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!loading)input.current?.focus();},[loading]);
  const groups=new Map<string,PickerChoice[]>();
  const listed=choices.some(choice=>choice.id===value)||!value?choices:[{id:value,label:value,available:false,unavailableReason:'Saved model is not in the current catalogue'},...choices];
  for(const choice of listed){
    const group=choice.providerLabel||'Other providers';
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group)!.push(choice);
  }
  const selected=listed.find(choice=>choice.id===value);
  const currentProvider=selected?.providerLabel||'Other providers';
  const searchLabel=provider?'Search models':'Search model providers';
  const choose=(choice:PickerChoice)=>{
    if(disabled||loading||!(choice.selectable??choice.available))return;
    onChange(choice.id);
  };
  return <div className="timber-model-picker-content" data-step={provider?'models':'providers'} aria-busy={loading}>
        <div className="timber-model-picker-heading">{provider&&<button type="button" aria-label="Back to model providers" onClick={()=>{setProvider(null);setQuery('');}}><ArrowLeftIcon aria-hidden="true"/></button>}<strong>{provider||'Choose provider'}</strong>{close}</div>
        <Command key={provider||'providers'} className="timber-model-command" label={searchLabel} defaultValue={provider?value:currentProvider} loop>
          <div className="timber-model-search"><SearchIcon aria-hidden="true"/><Command.Input ref={input} autoFocus disabled={disabled||loading} placeholder={provider?'Search models…':'Search providers…'} value={query} onValueChange={setQuery}/></div>
          {provider&&<div className="timber-model-price-heading"><span title="USD per million tokens">USD / 1M tokens</span><span>Input</span><span>Output</span><span/></div>}
          <Command.List className="timber-model-list" aria-label="Models">
            <Command.Empty className="timber-model-empty">{provider?'No models match your search.':'No model providers match your search.'}</Command.Empty>
            {!provider?[...groups].map(([name,items])=><Command.Item key={name} value={name} disabled={disabled||loading} onSelect={()=>{setProvider(name);setQuery('');}} className="timber-model-option timber-model-provider" data-provider={name} data-current={name===currentProvider}>
              <span className="timber-model-option-copy"><span className="timber-model-option-name">{name}</span></span>
              <span className="timber-model-provider-count">{items.length} {items.length===1?'model':'models'}</span>
              {name===currentProvider&&<CheckIcon className="timber-model-check" aria-label="Current provider"/>}<ChevronRightIcon className="timber-model-check" aria-hidden="true"/>
            </Command.Item>):(groups.get(provider)||[]).map(choice=>{
              const billing=modelBillingView(choice.usage,{model:choice.id,fast:Boolean(settings?.fast&&choice.supportsFast),reasoningEffort:settings?.reasoningEffort&&choice.reasoningEfforts?.includes(settings.reasoningEffort)?settings.reasoningEffort:choice.defaultReasoningEffort});
              return <Command.Item key={choice.id} value={choice.id} keywords={[choice.label,choice.providerLabel||'',choice.sourceLabel||'']} disabled={disabled||loading||!(choice.selectable??choice.available)} onSelect={()=>choose(choice)} className="timber-model-option timber-model-choice" data-current={choice.id===value} title={choice.id}>
                <span className="timber-model-option-name">{choice.label}{choice.supportsFast&&<ZapIcon aria-label="Supports Fast mode"/>}</span>
                {billing.preview.plan?<span className="timber-model-plan-price" aria-label="Uses plan allowance">—</span>:<><span className="timber-model-price" title={billing.preview.input} aria-label={`Input: ${billing.preview.input||'price unavailable'}`}>{billing.preview.input||'—'}</span><span className="timber-model-price" title={billing.preview.output} aria-label={`Output: ${billing.preview.output||'price unavailable'}`}>{billing.preview.output||'—'}</span></>}
                <span className="timber-model-check-slot">{choice.id===value&&<CheckIcon className="timber-model-check" aria-label="Current model"/>}</span>
                <span className="timber-model-option-usage"><span className="timber-model-usage-badge">{billing.label}</span>{billing.preview.hint&&<small>{billing.preview.hint}</small>}{!choice.available&&<small title={choice.unavailableReason}>{choice.selectable?'Configuration only':'Unavailable'}</small>}</span>
                {!choice.available&&<span className="timber-model-option-unavailable">{choice.unavailableReason||'Unavailable'}</span>}
              </Command.Item>;
            })}
          </Command.List>
        </Command>
  </div>;
}

export function ModelPicker({id,value,choices,disabled=false,loading=false,settings,onChange}:PickerProps) {
  const [open,setOpen]=useState(false);
  const current=choices.find(choice=>choice.id===value);
  return <Popover.Root open={open&&!disabled&&!loading} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button id={id} type="button" role="combobox" aria-label="Model" aria-expanded={open&&!disabled&&!loading} aria-haspopup="dialog" disabled={disabled||loading} className="timber-model-picker-trigger" title={value}>
        <span>{current?.label||value||'Choose a model'}</span><ChevronDownIcon aria-hidden="true"/>
      </button>
    </Popover.Trigger>
    {/* Native modal dialogs live above body portals. Keep their picker in the same top layer. */}
    <Popover.Portal container={(id&&document.getElementById(id)?.closest('dialog'))||document.fullscreenElement||document.body}>
      <Popover.Content className="timber-model-picker" align="start" sideOffset={6} collisionPadding={12} aria-label="Choose model" onCloseAutoFocus={event=>{if(disabled||loading)event.preventDefault();}}>
        <ModelPickerContent value={value} choices={choices} disabled={disabled} loading={loading} settings={settings} close={<Popover.Close className="timber-model-picker-close" aria-label="Close model picker"><XIcon aria-hidden="true"/></Popover.Close>} onChange={next=>{if(next!==value)onChange(next);setOpen(false);}}/>
        {current?.usage&&<div className="timber-model-picker-footer"><ModelBillingDetails usage={current.usage} settings={settings}/></div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Adapt the existing DOM forms to the same picker used by the React chat. */
export function mountModelPicker(select:HTMLSelectElement) {
  const host=document.createElement('div');host.className='timber-model-picker-host';select.after(host);
  const root=createRoot(host);
  let state:Omit<PickerProps,'id'|'value'|'onChange'>={choices:[]};
  const render=()=>root.render(<ModelPicker {...state} id={`${select.id}-picker`} value={select.value} onChange={value=>{
      select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));
      render();
    }}/>);
  return {update(next:typeof state){state=next;render();}};
}
