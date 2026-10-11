import {createAssistantMessageEventStream,type AssistantMessage,type AssistantMessageEvent} from '@earendil-works/pi-ai';
import {estimateContextTokens} from '@earendil-works/pi-ai/utils/estimate';
import {createProvider,type Provider} from '@earendil-works/pi-ai/models';
import {streamSimple as routerStream} from '@earendil-works/pi-ai/api/openai-completions';
import {modelFailure,routeSupportsSettings,type ModelRoute,type ModelSettings} from '@botspace/contracts';
import {classifyFailure} from './normalize.js';
import {chatgptModel,type ConfiguredModel} from './chatgpt.js';
import type {PiRuntimeOptions} from './types.js';

const ROUTER_URL='https://openrouter.ai/api/v1/chat/completions';
const zeroUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};

function providerFailure(source:string,message?:string){
  const failure=classifyFailure('model_error',message);
  if(source!=='openrouter')return failure;
  if(failure.errorCode==='chatgpt_allowance_exhausted')return modelFailure('model_billing_required');
  if(failure.errorCode==='chatgpt_not_connected')return modelFailure('model_access_denied');
  return failure;
}

export function routeModel(route:ModelRoute,settings:ModelSettings):ConfiguredModel {
  const cost=route.pricing?{input:route.pricing.input,output:route.pricing.output,cacheRead:route.pricing.cachedInput??route.pricing.input,cacheWrite:0}:{input:0,output:0,cacheRead:0,cacheWrite:0};
  return {...chatgptModel,id:route.modelId,name:route.name,
    provider:route.provider,api:route.source==='chatgpt'?'openai-responses':'openai-completions',
    baseUrl:route.source==='chatgpt'?chatgptModel.baseUrl:'https://openrouter.ai/api/v1',
    contextWindow:route.contextWindow??128_000,maxTokens:route.maxOutputTokens??32_768,
    input:route.inputModalities??['text'],reasoning:route.reasoningEfforts.length>0,cost,
    compat:route.source==='chatgpt'?chatgptModel.compat:{supportsDeveloperRole:true},
    timberSettings:{...settings,model:route.modelId},timberCapability:route};
}

export function createOpenRouterProvider(transport:PiRuntimeOptions<object>['openrouter'],available:()=>readonly ConfiguredModel[]) {
  const run:Provider['streamSimple']=(model,context,options)=>{
    const configured=model as ConfiguredModel,settings=configured.timberSettings??{model:model.id};
    return routerStream({...model,api:'openai-completions',id:settings.model},context,{
      apiKey:'timber-host-owned-router-transport',env:{},signal:options?.signal,maxRetries:0,
      timeoutMs:options?.timeoutMs??1_800_000,maxTokens:options?.maxTokens??4096,
      onPayload:(value)=>({...value as Record<string,unknown>,model:settings.model,provider:{require_parameters:true},...(settings.reasoningEffort?{reasoning:{effort:settings.reasoningEffort}}:{})}),
      fetch:async(input,init)=>{
        const incoming=new Request(input,init);
        if(incoming.url!==ROUTER_URL||incoming.method!=='POST')throw new Error('model_request_invalid');
        if(!transport)return Response.json({error:{code:'model_access_denied',message:'OpenRouter is not configured.'}},{status:403});
        return transport.fetch(new Request(ROUTER_URL,{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream'},body:await incoming.text(),signal:incoming.signal,redirect:'manual'}));
      },
    });
  };
  const provider=createProvider<'openai-completions'>({id:'openrouter',name:'OpenRouter',models:[],
    auth:{apiKey:{name:'Host-owned OpenRouter connection',resolve:async()=>({auth:{},source:'OpenRouter transport'})}},api:{stream:(model,context,options)=>run(model,context,{signal:options?.signal,maxTokens:options?.maxTokens}),streamSimple:run}});
  const models=()=>available().filter(model=>model.provider==='openrouter');
  return {...provider,getModels:models,getAllModels:models};
}

/** Retry inference only; the native generation and its recorded tool results stay the same. */
export function withQuotaFallback(provider:Provider,providers:ReadonlyMap<string,Provider>):Provider {
  const run:Provider['streamSimple']=(model,context,options)=>{
    const configured=model as ConfiguredModel,settings=configured.timberSettings??{model:model.id};
    const routes=configured.timberRoutes;
    if(!routes?.length)return provider.streamSimple(model,context,options);
    const output=createAssistantMessageEventStream();
    void (async()=>{
      let final:AssistantMessage|undefined,terminalPublished=false;
      try{
        for(let index=0;index<routes.length;index++){
          const route=routes[index],target=providers.get(route.source);
          if(!target||!routeSupportsSettings(route,settings))continue;
          if(context.messages.some(message=>typeof message.content!=='string'&&message.content.some(part=>part.type==='image'))&&!route.inputModalities?.includes('image'))continue;
          // A source's smaller context must not turn a quota recovery into truncation.
          const tokens=estimateContextTokens(context).tokens+(options?.maxTokens??4096);
          if(index>0&&(route.contextWindow===undefined||tokens>route.contextWindow||route.maxOutputTokens!==undefined&&(options?.maxTokens??4096)>route.maxOutputTokens))continue;
          if(options?.signal?.aborted)break;
          const upstream=target.streamSimple(routeModel(route,settings),context,options);
          const pending:AssistantMessageEvent[]=[];let emitted=false,retry=false;terminalPublished=false;
          for await(const original of upstream){
            let event=original;
            if(event.type==='error'){
              const failure=providerFailure(route.source,event.error.errorMessage);
              const code=failure.errorCode;
              event={...event,error:{...event.error,errorMessage:`${code}: ${failure.publicMessage}`}};
              retry=!emitted&&event.reason!=='aborted'&&!event.error.content.length&&!options?.signal?.aborted
                &&(code==='chatgpt_allowance_exhausted'||code==='model_billing_required')&&index+1<routes.length;
              if(retry){final=event.error;continue;}
            }
            if(event.type==='start'){pending.push(event);continue;}
            emitted=true;for(const saved of pending.splice(0))output.push(saved);output.push(event);
            if(event.type==='error'||event.type==='done')terminalPublished=true;
          }
          final=await upstream.result();
          if(final.stopReason==='error'){
            const failure=providerFailure(route.source,final.errorMessage);
            final={...final,errorMessage:`${failure.errorCode}: ${failure.publicMessage}`};
          }
          if(!retry)break;
        }
        if(options?.signal?.aborted&&!terminalPublished){final={...(final??{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],timestamp:Date.now(),usage:zeroUsage}),stopReason:'aborted',errorMessage:'Model request aborted'};output.push({type:'error',reason:'aborted',error:final});}
        else if(!final){const failure=modelFailure('model_access_denied');final={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',timestamp:Date.now(),usage:zeroUsage,errorMessage:`${failure.errorCode}: ${failure.publicMessage}`};output.push({type:'error',reason:'error',error:final});}
        else if(final.stopReason==='error'&&!terminalPublished)output.push({type:'error',reason:'error',error:final});
        output.end(final);
      }catch(error){const failure=classifyFailure('model_error',error instanceof Error?error.message:undefined);const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:options?.signal?.aborted?'aborted':'error',timestamp:Date.now(),usage:zeroUsage,errorMessage:`${failure.errorCode}: ${failure.publicMessage}`};output.push({type:'error',reason:message.stopReason as 'error'|'aborted',error:message});output.end(message);}
    })();
    return output;
  };
  return {...provider,streamSimple:run};
}
