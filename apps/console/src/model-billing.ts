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

/** Catalogue rates describe the route, not the actual cost of a future request. */
export function modelBillingLines(usage?:ModelUsage,settings?:ModelSettings,compact=false):string[] {
  if(!usage)return [];
  if(usage.imageApi)return ['OpenAI Image API · Separately billed','Token pricing unavailable'];
  if(usage.blocked)return ['Paid inference paused until the ChatGPT catalogue refreshes'];
  const routes=compact?usage.routes.slice(0,2):usage.routes;
  return routes.flatMap((route,index)=>{
    const fallback=index>0,label=`${sourceName(route.source)}${fallback?' fallback':''}`;
    if(fallback&&settings&&!routeSupportsSettings(route,settings))return [`${label} unavailable with these settings`];
    if(fallback&&route.contextWindow===undefined)return [`${label} unavailable: context capacity unknown`];
    if(route.source==='chatgpt')return ['Uses ChatGPT allowance · No per-token API charge'];
    if(route.source!=='openai-api'&&route.source!=='openrouter')return [`${label} · Token pricing unavailable`];
    const price=route.pricing;
    if(!price||!validPrice(price.input)||!validPrice(price.output))return [`${label} · Token pricing unavailable`];
    const rates=`Input ${usd.format(price.input)} · Output ${usd.format(price.output)}${validPrice(price.cachedInput)?` · Cached input ${usd.format(price.cachedInput)}`:''}`;
    const note=settings?.fast?' · Standard rates; Fast pricing unavailable':'';
    return compact?[`${fallback?`${label} · `:''}${rates} / 1M tokens (USD)${note}`]:[`${label} · USD / 1M tokens`,`${rates}${note}`];
  });
}
