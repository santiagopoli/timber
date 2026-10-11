import type {ModelCatalog,ModelOption,ModelRoute,ModelSettings} from './models';

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const positive=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;
const price=(value:unknown)=>typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value)*1_000_000:undefined;
export const isConcreteModelId=(value:unknown):value is string=>typeof value==='string'&&value.length<=180&&/^(?:@cf\/)?[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/.test(value)&&!/(?:^|[-/:])latest(?:$|[-/:])/i.test(value);

/** Strip only the explicit OpenAI namespace. Dates, tiers and variants stay distinct. */
export const canonicalModelId=(id:string)=>id.startsWith('openai/')?id.slice('openai/'.length):id;

/** OpenRouter maps its standardized efforts to the concrete model's supported effort. */
const ROUTER_EFFORTS=['none','minimal','low','medium','high','xhigh','max'];
export function normalizeOpenRouterCatalog(value:unknown):ModelOption[] {
  const data=object(value).data;if(!Array.isArray(data))throw new Error('Invalid OpenRouter model catalog');
  const result:ModelOption[]=[];const seen=new Set<string>();
  for(const item of data){
    const raw=object(item),architecture=object(raw.architecture),limits=object(raw.top_provider);
    const id=raw.id;if(!isConcreteModelId(id)||!id.includes('/')||id.startsWith('@cf/')||/:batch$/i.test(id)||seen.has(id))continue;
    const params=Array.isArray(raw.supported_parameters)?raw.supported_parameters:[];
    const inputs=Array.isArray(architecture.input_modalities)?architecture.input_modalities:[];
    const outputs=Array.isArray(architecture.output_modalities)?architecture.output_modalities:[];
    // Timber agents require text output and function tools; image generators and classifiers stay out.
    if(!outputs.includes('text')||!inputs.includes('text')||!params.includes('tools'))continue;
    seen.add(id);
    const pricing=object(raw.pricing),input=price(pricing.prompt),output=price(pricing.completion),cachedInput=price(pricing.input_cache_read);
    const option:ModelOption={id:canonicalModelId(id),canonicalId:canonicalModelId(id),name:typeof raw.name==='string'?raw.name.slice(0,120):id,provider:'openrouter',publisher:id.split('/')[0],
      reasoningEfforts:params.includes('reasoning')||params.includes('reasoning_effort')?[...ROUTER_EFFORTS]:[],supportsFast:false,
      ...(positive(raw.context_length)?{contextWindow:positive(raw.context_length)}:{}),
      ...(positive(limits.max_completion_tokens)?{maxOutputTokens:positive(limits.max_completion_tokens)}:{}),
      inputModalities:inputs.includes('image')?['text','image']:['text']};
    const {canonicalId:_canonical,...capabilities}=option;
    option.routes=[{...capabilities,id,modelId:id,source:'openrouter',...(input!==undefined&&output!==undefined?{pricing:{input,output,...(cachedInput===undefined?{}:{cachedInput})}}:{})}];
    result.push(option);
  }
  return result;
}

export interface ModelCatalogSource {id:string;priority:number;catalog:ModelCatalog;}
/** Sources normalize their own IDs/capabilities. Adding a source does not change this merge. */
export function mergeModelCatalogs(sources:readonly ModelCatalogSource[],defaultModel:string):ModelCatalog {
  const models=new Map<string,ModelOption>();
  for(const source of [...sources].sort((a,b)=>a.priority-b.priority)){
    if(!source.catalog.connected||source.catalog.error)continue;
    for(const model of source.catalog.models){
      const id=model.canonicalId??canonicalModelId(model.id);
      const {routes:provided,canonicalId:_canonical,...capabilities}=model;
      const routes=provided??[{...capabilities,source:source.id,modelId:model.id}];
      const existing=models.get(id);
      if(existing){
        for(const route of routes)if(!existing.routes!.some(item=>item.source===route.source&&item.modelId===route.modelId))existing.routes!.push(route);
      }else models.set(id,{...capabilities,id,canonicalId:id,routes:routes.map(route=>({...route}))});
    }
  }
  const connected=sources.some(source=>source.catalog.connected);
  const choices=[...models.values()];
  return {models:choices,connected,defaultModel:choices.find(model=>model.id===canonicalModelId(defaultModel))?.id??choices[0]?.id??defaultModel,
    sources:sources.map(source=>({id:source.id,connected:source.catalog.connected,...(source.catalog.error?{error:source.catalog.error}:{})})),
    ...(!choices.length&&sources.some(source=>source.catalog.error)?{error:'The model catalog is temporarily unavailable. Refresh and try again.'}:{})};
}

/** Never silently drop Fast, change reasoning, or send images to a text-only fallback. */
export function routeSupportsSettings(route:ModelRoute,settings:ModelSettings):boolean {
  return (!settings.fast||route.supportsFast)&&(!settings.reasoningEffort||route.reasoningEfforts.includes(settings.reasoningEffort));
}

/** A temporary subscription discovery failure is not authorization to start paid OpenAI inference. */
export function subscriptionDiscoveryBlocked(catalog:ModelCatalog,model:ModelOption):boolean {
  return !!catalog.sources?.some(source=>source.id==='chatgpt'&&source.connected&&source.error)
    &&model.routes?.[0]?.source==='openrouter'&&model.routes[0].modelId.startsWith('openai/');
}
