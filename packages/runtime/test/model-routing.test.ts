import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {describe,expect,it,vi} from 'vitest';
import {createAssistantMessageEventStream,type AssistantMessage,type AssistantMessageEvent} from '@earendil-works/pi-ai';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import {createProvider,type Provider} from '@earendil-works/pi-ai/models';
import {modelFailure,type ModelRoute,type ModelSettings} from '@botspace/contracts';
import {chatgptModel,createChatGPTProvider} from '../src/chatgpt';
import {createOpenRouterProvider,routeModel,withQuotaFallback} from '../src/model-routing';
import {createOpenAIProvider} from '../src/openai-api';
import {openAIRequest} from '../../../apps/api/src/openai-api';
import type {Env} from '../../../apps/api/src/env';
import {responsesFixture} from './responses-fixture';

const route=(source:string,extra:Partial<ModelRoute>={}):ModelRoute=>({id:'gpt-6.1-sol',modelId:source==='openrouter'?'openai/gpt-6.1-sol':'gpt-6.1-sol',source,name:'GPT-6.1 Sol',provider:source==='chatgpt'?'openai':source,reasoningEfforts:['medium'],supportsFast:false,inputModalities:['text','image'],contextWindow:1_048_576,maxOutputTokens:128_000,...extra});
const settings:ModelSettings={model:'gpt-6.1-sol',reasoningEffort:'medium',fast:false};
const model=(routes=[route('chatgpt'),route('openrouter')])=>({...chatgptModel,timberSettings:settings,timberRoutes:routes});
const context=normalizeContext({messages:[{role:'user',content:'Hello',timestamp:0}]});
const message=(stopReason:AssistantMessage['stopReason'],errorMessage?:string):AssistantMessage=>({...chatgptModel,role:'assistant',api:'openai-responses',model:'gpt-6.1-sol',content:[],stopReason,timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},...(errorMessage?{errorMessage}:{})});
const quota=message('error',`chatgpt_allowance_exhausted: ${modelFailure('chatgpt_allowance_exhausted').publicMessage}`);
function fake(source:string,result:AssistantMessage,events:AssistantMessageEvent[]=[]){let calls=0;const provider=createProvider({id:source,models:[],api:{stream(){throw new Error('unused');},streamSimple(){calls++;const stream=createAssistantMessageEventStream();events.forEach(event=>stream.push(event));stream.push(result.stopReason==='error'?{type:'error',reason:'error',error:result}:{type:'done',reason:'stop',message:result});stream.end(result);return stream;}}});return {provider,calls:()=>calls};}
async function collect(provider:Provider,selected=model(),messages=context,signal?:AbortSignal){const stream=provider.streamSimple(selected,messages,{signal});const events=[];for await(const event of stream)events.push(event);return {events,result:await stream.result()};}

describe('same-model quota fallback',()=>{
  it('exhausts the subscription and API credits in order before using the same model on OpenRouter',async()=>{
    const a=fake('chatgpt',quota),b=fake('openai-api',message('error','model_billing_required')),c=fake('openrouter',message('stop'));
    const providers=new Map([['chatgpt',a.provider],['openai-api',b.provider],['openrouter',c.provider]]);
    const selected=model([route('chatgpt'),route('openai-api'),route('openrouter')]);
    const result=await collect(withQuotaFallback(a.provider,providers),selected);
    expect(result.result.stopReason).toBe('stop');expect([a.calls(),b.calls(),c.calls()]).toEqual([1,1,1]);expect(result.events.map(event=>event.type)).toEqual(['done']);
  });
  it('never calls a paid route when the subscription succeeds',async()=>{
    const a=fake('chatgpt',message('stop')),b=fake('openai-api',message('stop')),c=fake('openrouter',message('stop'));
    await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openai-api',b.provider],['openrouter',c.provider]])),model([route('chatgpt'),route('openai-api'),route('openrouter')]));
    expect([a.calls(),b.calls(),c.calls()]).toEqual([1,0,0]);
  });
  it('skips an incompatible paid route without dropping Fast or reasoning settings',async()=>{
    const a=fake('chatgpt',quota),b=fake('openai-api',message('stop')),c=fake('openrouter',message('stop'));
    const providers=new Map([['chatgpt',a.provider],['openai-api',b.provider],['openrouter',c.provider]]);
    const selected={...model([route('chatgpt',{supportsFast:true}),route('openai-api'),route('openrouter',{supportsFast:true})]),timberSettings:{...settings,fast:true}};
    await collect(withQuotaFallback(a.provider,providers),selected);expect([a.calls(),b.calls(),c.calls()]).toEqual([1,0,1]);
  });
  it.each(['model_rate_limited','model_access_denied','model_provider_unavailable'])('does not switch away from the API for %s',async code=>{
    const a=fake('openai-api',message('error',code)),b=fake('openrouter',message('stop'));
    await collect(withQuotaFallback(a.provider,new Map([['openai-api',a.provider],['openrouter',b.provider]])),model([route('openai-api'),route('openrouter')]));expect(b.calls()).toBe(0);
  });
  it.each(['named','failed','nested'])('runs the actual paid Responses adapter and falls back for %s quota SSE without exposing provider prose',async kind=>{
    const error={code:'insufficient_quota',message:'PRIVATE_PROVIDER_DETAIL'};
    const data=kind==='failed'?{type:'response.failed',response:{id:'resp_quota',status:'failed',output:[],error}}:kind==='nested'?{error}:{type:'error',...error};
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(`${kind==='named'?'event: error\n':''}data: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}}));
    try{
      const a=createOpenAIProvider({fetch:request=>openAIRequest({OPENAI_API_KEY:'fixture-secret'} as Env,request)},()=>[]),b=fake('openrouter',message('stop'));
      const result=await collect(withQuotaFallback(a,new Map([['openai-api',a],['openrouter',b.provider]])),model([route('openai-api'),route('openrouter')]));
      expect(result.result.stopReason).toBe('stop');expect(b.calls()).toBe(1);expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fixture-secret');
    }finally{fetch.mockRestore();}
  });
  it('does not replay a failed terminal response that already contains output',async()=>{
    const data={type:'response.failed',response:{id:'resp_partial',status:'failed',output:[{type:'message',content:[{type:'output_text',text:'partial'}]}],error:{code:'insufficient_quota',message:'PRIVATE_DETAIL'}}};
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}}));
    try{
      const a=createOpenAIProvider({fetch:request=>openAIRequest({OPENAI_API_KEY:'fixture-secret'} as Env,request)},()=>[]),b=fake('openrouter',message('stop'));
      const result=await collect(withQuotaFallback(a,new Map([['openai-api',a],['openrouter',b.provider]])),model([route('openai-api'),route('openrouter')]));
      expect(result.result.stopReason).toBe('error');expect(result.result.errorMessage).toContain('model_connection_interrupted');expect(b.calls()).toBe(0);
    }finally{fetch.mockRestore();}
  });
  it('preserves recorded tools while switching to the actual paid Responses API and strips subscription namespaces and credentials',async()=>{
    let payload:Record<string,unknown>|undefined,authorization:string|null='not called';
    const paid=createOpenAIProvider({fetch:async request=>{
      payload=await request.json();authorization=request.headers.get('authorization');
      return responsesFixture({input:[{role:'user',content:'Hello'}]});
    }},()=>[]);
    const history=normalizeContext({messages:[{role:'user',content:'Hello',timestamp:0},{...message('toolUse'),content:[{type:'toolCall',id:'call_fixture|fc_fixture',name:'exec',arguments:{command:'echo once'},namespace:'timber_computer'}]},{role:'toolResult',toolCallId:'call_fixture|fc_fixture',toolName:'exec',content:[{type:'text',text:'already executed once'}],isError:false,timestamp:1}]});
    const a=fake('chatgpt',quota);const selected=model([route('chatgpt'),route('openai-api',{supportsFast:true,fastServiceTier:'priority'})]);
    const result=await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openai-api',paid]])),selected,history);
    expect(result.result.stopReason).toBe('stop');expect(result.result.provider).toBe('openai-api');expect(result.result.model).toBe('gpt-6.1-sol');
    expect(payload).toMatchObject({model:'gpt-6.1-sol',store:false,stream:true,reasoning:{effort:'medium'},max_output_tokens:4096});
    expect(JSON.stringify(payload)).toContain('already executed once');expect(JSON.stringify(payload)).not.toContain('timber_computer');expect(authorization).toBeNull();
    const input=payload!.input as Record<string,unknown>[];expect(input.find(item=>item.type==='function_call')?.call_id).toBe(input.find(item=>item.type==='function_call_output')?.call_id);
  });
  it('uses the subscription first and forwards the existing history once on quota exhaustion',async()=>{
    const a=fake('chatgpt',quota),b=fake('openrouter',message('stop'));const providers=new Map([['chatgpt',a.provider],['openrouter',b.provider]]);
    const result=await collect(withQuotaFallback(a.provider,providers));expect(result.result.stopReason).toBe('stop');expect(a.calls()).toBe(1);expect(b.calls()).toBe(1);expect(result.events.map(event=>event.type)).toEqual(['done']);
  });
  it.each(['model_rate_limited','model_access_denied','model_context_length_exceeded','model_provider_unavailable'])('does not switch for %s',async code=>{
    const a=fake('chatgpt',message('error',code)),b=fake('openrouter',message('stop'));const result=await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openrouter',b.provider]])));
    expect(b.calls()).toBe(0);expect(result.events.filter(event=>event.type==='error')).toHaveLength(1);
  });
  it.each(['text_delta','toolcall_start'] as const)('does not replay after %s',async type=>{
    const event:AssistantMessageEvent=type==='text_delta'?{type,contentIndex:0,delta:'partial',partial:quota}:{type,contentIndex:0,partial:quota};
    const a=fake('chatgpt',quota,[event]),b=fake('openrouter',message('stop'));await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openrouter',b.provider]])));expect(b.calls()).toBe(0);
  });
  it('retains the original quota failure when no alternate supports the settings or input',async()=>{
    for(const alternate of [route('openrouter',{reasoningEfforts:[]}),route('openrouter',{contextWindow:1}),route('openrouter',{inputModalities:['text']})]){
      const a=fake('chatgpt',quota),b=fake('openrouter',message('stop'));
      const images=normalizeContext({messages:[{role:'user',content:[{type:'image',data:'fixture',mimeType:'image/png'}],timestamp:0}]});
      const result=await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openrouter',b.provider]])),model([route('chatgpt'),alternate]),images);
      expect(b.calls()).toBe(0);expect(result.result.errorMessage).toContain('chatgpt_allowance_exhausted');expect(result.events.filter(event=>event.type==='error')).toHaveLength(1);
    }
    const a=fake('chatgpt',quota),b=fake('openrouter',message('stop'));const controller=new AbortController();controller.abort();await collect(withQuotaFallback(a.provider,new Map([['chatgpt',a.provider],['openrouter',b.provider]])),model(),context,controller.signal);expect(a.calls()).toBe(0);expect(b.calls()).toBe(0);
  });
  it('runs actual Pi Responses and Chat Completions adapters, preserves tool history and strips local credentials',async()=>{
    const requests:{url:string;payload:Record<string,unknown>;authorization:string|null}[]=[];
    const chatgpt=createChatGPTProvider({fetch:async request=>{requests.push({url:request.url,payload:await request.json(),authorization:request.headers.get('authorization')});return responsesFixture({input:[{role:'user',content:'request-wire-allowance nested'}]});}});
    const openrouter=createOpenRouterProvider({fetch:async request=>{
      requests.push({url:request.url,payload:await request.json(),authorization:request.headers.get('authorization')});
      const chunks=[{id:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Recovered'},finish_reason:null}]},{id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
      return new Response(chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }},()=>[]);
    const history=normalizeContext({messages:[{role:'user',content:'Hello',timestamp:0},{...message('toolUse'),content:[{type:'toolCall',id:'call_fixture|fc_fixture',name:'exec',arguments:{command:'echo once'},namespace:'timber_computer'}]},{role:'toolResult',toolCallId:'call_fixture|fc_fixture',toolName:'exec',content:[{type:'text',text:'already executed once'}],isError:false,timestamp:1}]});
    const result=await collect(withQuotaFallback(chatgpt,new Map<string,Provider>([['chatgpt',chatgpt],['openrouter',openrouter]])),model(),history);
    expect(result.result.content).toEqual([{type:'text',text:'Recovered'}]);expect(result.result.provider).toBe('openrouter');expect(result.result.model).toBe('openai/gpt-6.1-sol');
    expect(requests.map(request=>request.payload.model)).toEqual(['gpt-6.1-sol','openai/gpt-6.1-sol']);expect(requests.every(request=>request.authorization===null)).toBe(true);
    expect(JSON.stringify(requests[1].payload)).toContain('already executed once');expect(requests[1].payload.reasoning).toEqual({effort:'medium'});expect(requests[1].payload).not.toHaveProperty('service_tier');
  });
});

it('preserves transient SDK connection failures as native-retryable errors instead of generic terminal failures',async()=>{
 const provider=createChatGPTProvider({fetch:async()=>{throw new Error('fixture network failure');}});
 const guarded=withQuotaFallback(provider,new Map([['chatgpt',provider]]));
 const model={...chatgptModel,timberRoutes:[{source:'chatgpt',provider:'openai',modelId:chatgptModel.id,name:'Fixture',reasoningEfforts:[],supportsFast:false}]};
 const stream=guarded.streamSimple(model,{messages:[{role:'user',content:'Hello',timestamp:0}]},{});
 for await(const _ of stream){}const result=await stream.result();
 expect(result.errorMessage).toContain('model_connection_interrupted');expect(isRetryableAssistantError(result)).toBe(true);
 expect(result.errorMessage).not.toContain('fixture network failure');
});
