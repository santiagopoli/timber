import {type Model,type SimpleStreamOptions,type TranscriptContext} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-responses';
import {createProvider} from '@earendil-works/pi-ai/models';
import {classifyModelFailure} from '@botspace/contracts';
import {RESPONSES_URL,type ConfiguredModel} from './chatgpt.js';
import type {PiRuntimeOptions} from './types.js';
import {inferenceCacheKey} from './inference-policy.js';

/** Ordinary paid Responses API, independently identified from the ChatGPT plan. */
export function createOpenAIProvider(transport:PiRuntimeOptions<object>['openai'],available:()=>readonly ConfiguredModel[],cacheScope?:()=>Promise<string>) {
  const run=(model:Model<'openai-responses'>,context:TranscriptContext,options?:SimpleStreamOptions)=>{
    const configured=model as ConfiguredModel,settings=configured.timberSettings??{model:model.id};
    return streamSimple({...model,id:settings.model},context,{
      apiKey:'sk-timber-host-owned-api-transport',env:{},signal:options?.signal,maxRetries:0,cacheRetention:'short',
      timeoutMs:options?.timeoutMs??1_800_000,maxTokens:options?.maxTokens??4096,
      onPayload:async value=>{
        const payload=value as Record<string,unknown>;
        if(!Array.isArray(payload.input))throw new Error('model_request_invalid');
        const input=payload.input.map(value=>{
          const item=value as Record<string,unknown>;
          if(item.type!=='function_call')return item;
          // Namespaces belong to the subscription transport, not the paid API.
          const {namespace:_namespace,...flat}=item;return flat;
        });
        const {reasoning:_reasoning,service_tier:_tier,...base}=payload;
        const cacheKey=cacheScope?await inferenceCacheKey(await cacheScope(),options?.sessionId):undefined;
        return {...base,model:settings.model,input,store:false,stream:true,...(cacheKey?{prompt_cache_key:cacheKey}:{}),
          ...(settings.reasoningEffort?{reasoning:{effort:settings.reasoningEffort}}:{}),
          ...(settings.fast?{service_tier:configured.timberCapability?.fastServiceTier??'priority'}:{})};
      },
      fetch:async(input,init)=>{
        const incoming=new Request(input,init);
        if(incoming.url!==RESPONSES_URL||incoming.method!=='POST')throw new Error('model_request_invalid');
        if(!transport)return Response.json({error:{code:'model_access_denied',message:'model_access_denied'}},{status:403});
        return transport.fetch(new Request(RESPONSES_URL,{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream'},body:await incoming.text(),signal:incoming.signal,redirect:'manual'}));
      },
      onProviderStreamEvent:value=>{
        const event=value as Record<string,unknown>;
        if(event.type!=='error'&&event.type!=='response.failed')return;
        const parent=event.type==='response.failed'?event.response as Record<string,unknown>:event;
        const detail=(parent.error??parent) as {code?:unknown;param?:unknown;message?:unknown};
        const failure=classifyModelFailure(detail);
        throw new Error(`${failure.errorCode}: ${failure.publicMessage}`);
      },
    });
  };
  const provider=createProvider<'openai-responses'>({id:'openai-api',name:'OpenAI API',models:[],
    auth:{apiKey:{name:'Host-owned OpenAI API connection',resolve:async()=>({auth:{},source:'OpenAI API transport'})}},
    api:{stream:(model,context,options)=>run(model as Model<'openai-responses'>,context,{signal:options?.signal,maxTokens:options?.maxTokens}),streamSimple:(model,context,options)=>run(model as Model<'openai-responses'>,context,options)}});
  const models=()=>available().filter(model=>model.provider==='openai-api');
  return {...provider,getModels:models,getAllModels:models};
}
