import {afterEach,describe,expect,it,vi} from 'vitest';
import {mergeModelCatalogs,normalizeOpenAICatalog,normalizeModelCatalog,normalizeOpenRouterCatalog,subscriptionDiscoveryBlocked} from '@botspace/contracts';
import {openAICatalog,openAIRequest} from '../apps/api/src/openai-api';
import {modelCatalog,validateModelSettings} from '../apps/api/src/model-catalog';
import type {Env} from '../apps/api/src/env';

const api='https://api.openai.com/v1';
const registry={openai:{models:{
  'gpt-6.1-sol':{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',tool_call:true,reasoning:true,reasoning_options:[{type:'effort',values:['low','medium','high','xhigh','max']}],modalities:{input:['text','image'],output:['text']},limit:{context:1_050_000,output:128_000},cost:{input:2,output:10,cache_read:.1},experimental:{modes:{fast:{provider:{body:{service_tier:'priority'}}}}}},
  'gpt-6.1-sol-20260929':{id:'gpt-6.1-sol-20260929',name:'GPT-6.1 Sol',tool_call:true,modalities:{input:['text'],output:['text']}},
  'image-generator':{id:'image-generator',tool_call:false,modalities:{input:['text'],output:['image']}},
  'gpt-latest':{id:'gpt-latest',tool_call:true,modalities:{input:['text'],output:['text']}},
}}};
const account={data:['gpt-6.1-sol','gpt-6.1-sol-20260929','image-generator','gpt-latest','unknown-new-model'].map(id=>({id}))};
afterEach(()=>vi.restoreAllMocks());

describe('OpenAI API account catalog',()=>{
  it('intersects live access and capability metadata without inventing aliases or tool support',()=>{
    const models=normalizeOpenAICatalog(account,registry);expect(models.map(model=>model.id)).toEqual(['gpt-6.1-sol','gpt-6.1-sol-20260929']);
    expect(models[0]).toMatchObject({provider:'openai-api',publisher:'openai',reasoningEfforts:['low','medium','high','xhigh','max'],defaultReasoningEffort:'medium',supportsFast:true,fastServiceTier:'priority',contextWindow:1_050_000});
    expect(models[0].routes?.[0]).toMatchObject({source:'openai-api',modelId:'gpt-6.1-sol',pricing:{input:2,output:10,cachedInput:.1}});
    expect(normalizeOpenAICatalog({data:[]},registry)).toEqual([]);
    expect(()=>normalizeOpenAICatalog(account,{})).toThrow();
  });
  it('deduplicates exact identities in subscription, direct API, router order',()=>{
    const direct={connected:true,defaultModel:'',models:normalizeOpenAICatalog(account,registry)};
    const subscription={connected:true,defaultModel:'',models:normalizeModelCatalog({models:[{slug:'gpt-6.1-sol',visibility:'list',supported_reasoning_levels:[{effort:'medium'}]}]})};
    const router={connected:true,defaultModel:'',models:normalizeOpenRouterCatalog({data:[{id:'openai/gpt-6.1-sol',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools','reasoning']}]})};
    const sources=[{id:'openrouter',priority:10,catalog:router},{id:'openai-api',priority:5,catalog:direct},{id:'chatgpt',priority:0,catalog:subscription}];
    const combined=mergeModelCatalogs(sources,'gpt-6.1-sol');expect(combined.models).toHaveLength(2);
    expect(combined.models[0].routes?.map(route=>route.source)).toEqual(['chatgpt','openai-api','openrouter']);
    expect(combined.models[0].reasoningEfforts).toEqual(['medium']);
    const keyOnly=mergeModelCatalogs(sources.slice(0,2),'gpt-6.1-sol');expect(keyOnly.models[0].provider).toBe('openai-api');
    expect(subscriptionDiscoveryBlocked({...keyOnly,sources:[{id:'chatgpt',connected:true,error:'unavailable'}]},keyOnly.models[0])).toBe(true);
  });
  it('coalesces discovery, isolates key rotation, and never sends account credentials to models.dev',async()=>{
    const calls:{url:string;authorization:string|null}[]=[];
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      calls.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});
      return Response.json(String(input)===`${api}/models`?account:registry);
    });
    const server={OPENAI_API_KEY:'fixture-key-one'} as Env;
    const [a,b]=await Promise.all([modelCatalog(server),modelCatalog(server)]);expect(a).toEqual(b);
    expect(a.models[0].routes?.[0].source).toBe('openai-api');expect(a.sources?.find(source=>source.id==='openai-api')?.connected).toBe(true);
    expect(calls.filter(call=>call.url===`${api}/models`)).toEqual([{url:`${api}/models`,authorization:'Bearer fixture-key-one'}]);
    expect(calls.find(call=>call.url==='https://models.dev/api.json')?.authorization).toBeNull();
    expect(JSON.stringify(a)).not.toContain('fixture-key');
    expect(await validateModelSettings(server,{model:'gpt-6.1-sol',reasoningEffort:'high',fast:true})).toEqual({model:'gpt-6.1-sol',reasoningEffort:'high',fast:true});
    server.OPENAI_API_KEY='fixture-key-two';await openAICatalog(server);expect(calls.filter(call=>call.url===`${api}/models`)).toHaveLength(2);
    delete server.OPENAI_API_KEY;expect((await modelCatalog(server)).models).toEqual([]);
  });
  it('does not expose provider bodies or retain another key account on discovery failure',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('PRIVATE_ACCOUNT_BODY',{status:401}));
    const result=await openAICatalog({OPENAI_API_KEY:'bad-fixture-key'} as Env);
    expect(result.models).toEqual([]);expect(result.error).toBeDefined();expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('host-owned paid OpenAI transport',()=>{
  it.each([[429,'insufficient_quota','model_billing_required'],[429,'rate_limit_exceeded','model_rate_limited'],[401,'invalid_api_key','model_access_denied'],[403,'permission_denied','model_access_denied'],[400,'billing_hard_limit_reached','model_billing_required']] as const)('classifies HTTP %s %s safely',async(status,code,expected)=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({error:{code,message:'PRIVATE_PROVIDER_DETAIL'}},{status}));
    const response=await openAIRequest({OPENAI_API_KEY:'fixture-secret'} as Env,new Request(`${api}/responses`,{method:'POST',headers:{authorization:'PRIVATE_OWNER_TOKEN','x-private':'PRIVATE_HEADER'},body:'{}'}));
    expect(await response.json()).toEqual({error:{code:expected,message:expected}});
    const headers=new Headers(fetch.mock.calls[0][1]?.headers);expect(headers.get('authorization')).toBe('Bearer fixture-secret');expect(headers.has('x-private')).toBe(false);
    expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
  });
  it('rejects missing credentials and arbitrary inference endpoints before dispatch',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    const response=await openAIRequest({} as Env,new Request(`${api}/responses`,{method:'POST',body:'{}'}));expect(response.status).toBe(403);
    await expect(openAIRequest({OPENAI_API_KEY:'fixture'} as Env,new Request('https://evil.test/responses',{method:'POST',body:'{}'}))).rejects.toThrow('Unsupported');expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['named','failed','nested'])('retains safe quota codes across split %s SSE frames',async kind=>{
    const error={code:'insufficient_quota',message:'PRIVATE_PROVIDER_DETAIL'};
    const data=kind==='failed'?{type:'response.failed',response:{error}}:kind==='nested'?{error}:{type:'error',...error};
    const wire=`${kind==='named'?'event: error\r\n':''}data: ${JSON.stringify(data)}\r\n\r\n`;
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new ReadableStream({start(controller){for(const part of [wire.slice(0,13),wire.slice(13,36),wire.slice(36)])controller.enqueue(new TextEncoder().encode(part));controller.close();}}),{headers:{'content-type':'text/event-stream'}}));
    const response=await openAIRequest({OPENAI_API_KEY:'fixture'} as Env,new Request(`${api}/responses`,{method:'POST',body:'{}'}));
    const text=await response.text();expect(text).toContain('model_billing_required');expect(text).not.toContain('PRIVATE');
  });
});
