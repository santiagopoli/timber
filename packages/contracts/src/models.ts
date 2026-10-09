/** Account-scoped inference choices; no credentials or provider raw metadata. */
export interface ModelSettings { model:string; reasoningEffort?:string; fast?:boolean; }
export interface ModelOption {
  id:string; name:string; description?:string; provider:'openai';
  reasoningEfforts:string[]; defaultReasoningEffort?:string; supportsFast:boolean;
  fastServiceTier?:string; contextWindow?:number; maxOutputTokens?:number;
  inputModalities?:('text'|'image')[]; supportsReasoningSummary?:boolean;
}
export interface ModelCatalog {models:ModelOption[];connected:boolean;defaultModel:string;error?:string;}
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const token=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const positive=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;
/** SIWC returns an ordered account catalogue, not the API-key data[] catalogue. */
export function normalizeModelCatalog(value:unknown):ModelOption[] {
  const source=record(value).models;if(!Array.isArray(source))throw new Error('Invalid account model catalogue');
  const seen=new Set<string>();const result:ModelOption[]=[];
  for(const item of source){const raw=record(item);if(raw.visibility!=='list'||!token(raw.slug)||seen.has(raw.slug))continue;
    const efforts=(Array.isArray(raw.supported_reasoning_levels)?raw.supported_reasoning_levels:[]).map(value=>record(value).effort).filter(token);
    const tiers=(Array.isArray(raw.service_tiers)?raw.service_tiers:[]).map(value=>record(value).id);
    const tier=tiers.includes('fast')?'fast':tiers.includes('priority')?'priority':Array.isArray(raw.additional_speed_tiers)&&raw.additional_speed_tiers.includes('fast')?'fast':undefined;
    const modalities=Array.isArray(raw.input_modalities)?raw.input_modalities.filter((value):value is 'text'|'image'=>value==='text'||value==='image'):['text' as const];
    seen.add(raw.slug);result.push({id:raw.slug,name:typeof raw.display_name==='string'?raw.display_name.slice(0,120):raw.slug,provider:'openai',
      ...(typeof raw.description==='string'?{description:raw.description.slice(0,600)}:{}),reasoningEfforts:[...new Set(efforts)],
      ...(typeof raw.default_reasoning_level==='string'&&efforts.includes(raw.default_reasoning_level)?{defaultReasoningEffort:raw.default_reasoning_level}:{}),supportsFast:!!tier,...(tier?{fastServiceTier:tier}:{}),
      ...(positive(raw.context_window)?{contextWindow:positive(raw.context_window)}:{}),...(positive(raw.max_output_tokens)?{maxOutputTokens:positive(raw.max_output_tokens)}:{}),
      inputModalities:modalities,supportsReasoningSummary:raw.supports_reasoning_summary_parameter!==false});
  }return result;
}
export function resolveModelSettings(input:ModelSettings,models:readonly ModelOption[]):ModelSettings {
  const model=models.find(model=>model.id===input.model);if(!model)throw new Error('This model is not available in the connected account. Refresh the model catalogue.');
  if(input.reasoningEffort!==undefined&&!model.reasoningEfforts.includes(input.reasoningEffort))throw new Error('This reasoning level is not supported by the selected model.');
  if(input.fast&&!model.supportsFast)throw new Error('Fast mode is not supported by the selected model.');
  const reasoningEffort=input.reasoningEffort??model.defaultReasoningEffort;
  return {model:input.model,...(reasoningEffort?{reasoningEffort}:{}),fast:input.fast??false};
}
