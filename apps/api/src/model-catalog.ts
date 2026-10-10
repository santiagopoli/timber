import {classifyModelFailure,mergeModelCatalogs,normalizeOpenRouterCatalog,resolveModelSettings,subscriptionDiscoveryBlocked,type ModelCatalog,type ModelCatalogSource,type ModelSettings} from '@botspace/contracts';
import type {Env} from './env';
import {ApiError} from './errors';

const OPENROUTER='https://openrouter.ai/api/v1';
const caches=new WeakMap<Env,{key:string;expiresAt:number;catalog?:ModelCatalog;pending?:Promise<ModelCatalog>}>();

async function routerCatalog(env:Env):Promise<ModelCatalog>{
  const key=env.OPENROUTER_API_KEY;
  if(!key)return {connected:false,models:[],defaultModel:''};
  let cache=caches.get(env);
  if(cache?.key!==key){cache={key,expiresAt:0};caches.set(env,cache);}
  if(cache.catalog&&cache.expiresAt>Date.now())return cache.catalog;
  if(cache.pending)return cache.pending;
  const current=cache;
  const pending=(async()=>{
    try{
      const response=await fetch(`${OPENROUTER}/models/user`,{headers:{authorization:`Bearer ${key}`},redirect:'manual',signal:AbortSignal.timeout(15_000)});
      if(!response.ok){await response.body?.cancel();throw new Error('catalog');}
      const reader=response.body?.getReader();if(!reader)throw new Error('catalog');
      let bytes=0,text='';const decoder=new TextDecoder();
      try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8_000_000)throw new Error('catalog');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      finally{await reader.cancel().catch(()=>{});}
      const models=normalizeOpenRouterCatalog(JSON.parse(text));
      const catalog={connected:true,models,defaultModel:models[0]?.id??''};
      current.catalog=catalog;current.expiresAt=Date.now()+5*60_000;return catalog;
    }catch{return {connected:true,models:[],defaultModel:'',error:'OpenRouter model discovery is unavailable. Check its server connection and retry.'};}
  })();
  current.pending=pending;
  try{return await pending;}finally{if(current.pending===pending)current.pending=undefined;}
}

/** Each source owns discovery and credentials. Merge consumes only public normalized options. */
export async function modelCatalog(env:Env,owner='owner'):Promise<ModelCatalog>{
  const loaders:{id:string;priority:number;load:()=>Promise<ModelCatalog>}[]=[
    {id:'chatgpt',priority:0,load:async()=>{
      if(!env.CHATGPT)return {connected:false,models:[],defaultModel:''};
      const response=await env.CHATGPT.get(env.CHATGPT.idFromName(owner)).fetch('https://chatgpt/models');
      if(!response.ok)throw new Error('catalog');return response.json<ModelCatalog>();
    }},
    {id:'openrouter',priority:10,load:()=>routerCatalog(env)},
  ];
  const sources:ModelCatalogSource[]=await Promise.all(loaders.map(async source=>{
    try{return {id:source.id,priority:source.priority,catalog:await source.load()};}
    catch{return {id:source.id,priority:source.priority,catalog:{connected:true,models:[],defaultModel:'',error:`${source.id==='chatgpt'?'ChatGPT':'OpenRouter'} model discovery is unavailable. Retry shortly.`}};}
  }));
  return mergeModelCatalogs(sources,env.BOTSPACE_DEFAULT_MODEL??'gpt-6.1-sol');
}

export async function validateModelSettings(env:Env,input:ModelSettings):Promise<ModelSettings>{
  const catalog=await modelCatalog(env);
  if(!catalog.connected)throw new ApiError(409,'chatgpt_not_connected','Connect ChatGPT or configure OpenRouter before choosing a model.');
  if(catalog.error)throw new ApiError(503,'model_catalog_unavailable',catalog.error);
  const model=catalog.models.find(model=>model.id===input.model);
  if(model&&subscriptionDiscoveryBlocked(catalog,model))throw new ApiError(503,'model_catalog_unavailable','The ChatGPT catalog is temporarily unavailable. Retry before using paid OpenAI inference.');
  try{return resolveModelSettings(input,catalog.models);}
  catch(error){throw new ApiError(400,'invalid_model_settings',error instanceof Error?error.message:'Invalid model settings.');}
}

/** Fixed upstream and fresh headers: no owner token, SDK sentinel, or arbitrary endpoint. */
export async function openRouterRequest(env:Env,request:Request):Promise<Response>{
  if(request.url!==`${OPENROUTER}/chat/completions`||request.method!=='POST')throw new Error('Unsupported OpenRouter inference route');
  if(!env.OPENROUTER_API_KEY)return Response.json({error:{code:'model_access_denied',message:'OpenRouter is not configured.'}},{status:403});
  const response=await fetch(request.url,{method:'POST',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json',accept:'text/event-stream'},body:request.body,redirect:'manual',signal:request.signal});
  if(response.ok)return response;
  // Inspect a bounded error body only to classify it; never forward provider prose.
  let detail:{code?:unknown;param?:unknown;message?:unknown}={};
  const reader=response.body?.getReader();let text='',bytes=0;
  try{const decoder=new TextDecoder();if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32_000)break;text+=decoder.decode(part.value,{stream:true});}const raw=JSON.parse(text);if(raw?.error&&typeof raw.error==='object')detail=raw.error;}catch{}finally{await reader?.cancel().catch(()=>{});}
  const failure=classifyModelFailure({...detail,status:response.status});
  const code=response.status===402||failure.errorCode==='chatgpt_allowance_exhausted'?'model_billing_required':response.status===401||response.status===403?'model_access_denied':failure.errorCode;
  return Response.json({error:{code,message:code}},{status:response.status});
}
