import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Popover} from 'radix-ui';
import {Command} from 'cmdk';
import {ArrowLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon, ZapIcon} from 'lucide-react';
import './model-picker.css';

export type PickerChoice = {
  id:string;label:string;available:boolean;unavailableReason?:string;
  providerLabel?:string;sourceLabel?:string;supportsFast?:boolean;
  /** Unavailable avatar models can still be saved as theme configuration. */
  selectable?:boolean;
};
type PickerProps = {
  id?:string;value:string;choices:PickerChoice[];disabled?:boolean;loading?:boolean;
  onChange(value:string):void;
};

export function ModelPicker({id,value,choices,disabled=false,loading=false,onChange}:PickerProps) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[provider,setProvider]=useState<string|null>(null);
  const current=choices.find(choice=>choice.id===value);
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
    if(choice.id!==value)onChange(choice.id);
    setOpen(false);
  };
  return <Popover.Root open={open&&!disabled&&!loading} onOpenChange={next=>{setOpen(next);setQuery('');setProvider(null);}}>
    <Popover.Trigger asChild>
      <button id={id} type="button" role="combobox" aria-label="Model" aria-expanded={open&&!disabled&&!loading} aria-haspopup="dialog" disabled={disabled||loading} className="timber-model-picker-trigger" title={value}>
        <span>{current?.label||value||'Choose a model'}</span><ChevronDownIcon aria-hidden="true"/>
      </button>
    </Popover.Trigger>
    {/* Native modal dialogs live above body portals. Keep their picker in the same top layer. */}
    <Popover.Portal container={(id&&document.getElementById(id)?.closest('dialog'))||document.fullscreenElement||document.body}>
      <Popover.Content className="timber-model-picker" data-step={provider?'models':'providers'} align="start" sideOffset={6} collisionPadding={12} aria-label="Choose model" onCloseAutoFocus={event=>{if(disabled||loading)event.preventDefault();}}>
        {provider&&<div className="timber-model-provider-heading"><button type="button" aria-label="Back to model providers" onClick={()=>{setProvider(null);setQuery('');}}><ArrowLeftIcon aria-hidden="true"/></button><strong>{provider}</strong></div>}
        <Command key={provider||'providers'} label={searchLabel} defaultValue={provider?value:currentProvider} loop>
          <div className="timber-model-search"><SearchIcon aria-hidden="true"/><Command.Input autoFocus placeholder={provider?`Search ${provider} models…`:'Choose a model provider…'} value={query} onValueChange={setQuery}/></div>
          <Command.List className="timber-model-list" aria-label="Models">
            <Command.Empty className="timber-model-empty">{provider?'No models match your search.':'No model providers match your search.'}</Command.Empty>
            {!provider?[...groups].map(([name,items])=><Command.Item key={name} value={name} onSelect={()=>{setProvider(name);setQuery('');}} className="timber-model-option timber-model-provider" data-provider={name} data-current={name===currentProvider}>
              <span className="timber-model-option-copy"><span className="timber-model-option-name">{name}</span></span>
              <span className="timber-model-provider-count">{items.length} {items.length===1?'model':'models'}</span>
              {name===currentProvider&&<CheckIcon className="timber-model-check" aria-label="Current provider"/>}<ChevronRightIcon className="timber-model-check" aria-hidden="true"/>
            </Command.Item>):(groups.get(provider)||[]).map(choice=><Command.Item key={choice.id} value={choice.id} keywords={[choice.label,choice.providerLabel||'',choice.sourceLabel||'']} disabled={!(choice.selectable??choice.available)} onSelect={()=>choose(choice)} className="timber-model-option" data-current={choice.id===value}>
                <span className="timber-model-option-copy"><span className="timber-model-option-name">{choice.label}{choice.supportsFast&&<ZapIcon aria-label="Supports Fast mode"/>}</span>
                  {choice.label!==choice.id&&<span className="timber-model-option-id">{choice.id}</span>}
                  {choice.sourceLabel&&<span className="timber-model-option-detail">{choice.sourceLabel}</span>}
                  {!choice.available&&<span className="timber-model-option-detail">{choice.unavailableReason||'Unavailable'}{choice.selectable?' · Configuration only':''}</span>}
                </span>
                {choice.id===value&&<CheckIcon className="timber-model-check" aria-label="Current model"/>}
              </Command.Item>)}
          </Command.List>
        </Command>
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
