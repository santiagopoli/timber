import type {ModelCatalog, ModelOption, ModelRoute, ModelSettings} from '../../../packages/contracts/src/models';
import {routeSupportsSettings, subscriptionDiscoveryBlocked} from '../../../packages/contracts/src/model-catalog';

export type ModelUsage = {routes:ModelRoute[];blocked?:boolean;imageApi?:boolean};
const sourceName=(source:string)=>source==='chatgpt'?'ChatGPT':source==='openai-api'?'OpenAI API':source==='openrouter'?'OpenRouter':source;
const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:6});
const validPrice=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** Legacy account catalogues have no routes. Never infer billing from the publisher. */
export function modelUsage(model:ModelOption,catalog?:ModelCatalog):ModelUsage {
  const source=model.provider==='openai'?'chatgpt':model.provider;
  const routes=model.routes?.length?model.routes:[{...model,source,modelId:model.id}];
  return {routes,blocked:catalog?subscriptionDiscoveryBlocked(catalog,model):false};
}

export type BillingRow = {source:string;name:string;fallback:boolean;status:'plan'|'priced'|'unknown'|'paused'|'incompatible'|'fast';input?:string;output?:string;cached?:string;message?:string};
export type BillingView = {label:string;rows:BillingRow[];preview:{input?:string;output?:string;hint?:string;plan?:boolean};note?:string};

/** Structured display data keeps route eligibility and price formatting consistent across views. */
export function modelBillingView(usage?:ModelUsage,settings?:ModelSettings):BillingView {
  if(!usage)return {label:'Usage unknown',rows:[],preview:{hint:'Price unavailable'}};
  if(usage.imageApi)return {label:'Image API',rows:[{source:'image-api',name:'Image API',fallback:false,status:'unknown',message:'Price unavailable'}],preview:{hint:'Separately billed'},note:'Billed separately from ChatGPT'};
  const rows:BillingRow[]=usage.routes.map((route,index)=>{
    const base={source:route.source,name:route.source==='chatgpt'?'ChatGPT plan':sourceName(route.source),fallback:index>0};
    if(usage.blocked)return {...base,status:'paused',message:'Paused'};
    if(index>0&&settings&&!routeSupportsSettings(route,settings))return {...base,status:'incompatible',message:settings.fast&&!route.supportsFast?'Fast unsupported':'Reasoning unsupported'};
    if(index>0&&route.contextWindow===undefined)return {...base,status:'incompatible',message:'Context unknown'};
    if(route.source==='chatgpt')return {...base,status:'plan',message:'Plan allowance'};
    if(settings?.fast)return {...base,status:'fast',message:'Fast price unavailable'};
    const price=route.pricing;
    if(!['openai-api','openrouter'].includes(route.source)||!price||!validPrice(price.input)||!validPrice(price.output))return {...base,status:'unknown',message:'Price unavailable'};
    return {...base,status:'priced',input:usd.format(price.input),output:usd.format(price.output),...(validPrice(price.cachedInput)?{cached:usd.format(price.cachedInput)}:{})};
  });
  const primary=rows[0],plan=primary?.status==='plan';
  const quoted=plan?rows.slice(1).find(row=>!['incompatible','paused'].includes(row.status)):primary;
  return {label:usage.blocked?'Usage paused':primary?.name||'Usage unknown',rows,
    preview:{input:quoted?.input,output:quoted?.output,plan:plan&&!quoted,hint:plan&&quoted?`Fallback: ${quoted.name}`:quoted?.message},
    ...(usage.blocked?{note:'Refresh the ChatGPT catalogue'}:rows.length>1?{note:'Fallback after quota or billing limits; request compatibility applies'}:{})};
}
