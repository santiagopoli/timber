import {afterEach,describe,expect,it,vi} from 'vitest';
import {mergeModelCatalogs,normalizeModelCatalog,normalizeOpenRouterCatalog,subscriptionDiscoveryBlocked,type ModelCatalog} from '@botspace/contracts';
import {modelCatalog,openRouterRequest,validateModelSettings} from '../apps/api/src/model-catalog';
import {parseBotInput} from '../apps/api/src/validation';
import type {Env} from '../apps/api/src/env';

const plan=(models:unknown[]):ModelCatalog=>({connected:true,defaultModel:'gpt-6.1-sol',models:normalizeModelCatalog({models})});
const rawRouter=(id:string,extra:Record<string,unknown>={})=>({id,name:id,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools','reasoning'],context_length:1_048_576,top_provider:{max_completion_tokens:128_000},pricing:{prompt:'0.000003',completion:'0.000015',input_cache_read:'0.0000003'},...extra});
const router=(data:unknown[]):ModelCatalog=>({connected:true,defaultModel:'',models:normalizeOpenRouterCatalog({data})});
const subscription={slug:'gpt-6.1-sol',display_name:'GPT-6.1 Sol',visibility:'list',supported_reasoning_levels:[{effort:'medium'}],default_reasoning_level:'medium',input_modalities:['text','image']};
const combined=()=>mergeModelCatalogs([{id:'openrouter',priority:10,catalog:router([rawRouter('openai/gpt-6.1-sol'),rawRouter('moonshotai/kimi-k3')])},{id:'chatgpt',priority:0,catalog:plan([subscription])}],'gpt-6.1-sol');
afterEach(()=>vi.restoreAllMocks());

describe('multiple concrete model catalogs',()=>{
  it('keeps cached subscription routes preferred, exposes the warning and pauses unknown paid-only OpenAI identities',()=>{
    const cached={...plan([subscription]),warning:'Using cached ChatGPT model catalogue (HTTP 520; model_provider_unavailable).'};
    const result=mergeModelCatalogs([{id:'chatgpt',priority:0,catalog:cached},{id:'openrouter',priority:10,catalog:router([rawRouter('openai/gpt-6.1-sol'),rawRouter('openai/gpt-new-unknown')])}],'gpt-6.1-sol');
    expect(result.models[0].routes?.[0].source).toBe('chatgpt');expect(result.sources?.[0].error).toBe(cached.warning);
    expect(subscriptionDiscoveryBlocked(result,result.models[0])).toBe(false);
    expect(subscriptionDiscoveryBlocked(result,result.models[1])).toBe(true);
  });
  it('deduplicates exact identity, prefers subscription capabilities, and retains priced alternate routes',()=>{
    const catalog=combined();expect(catalog.models.map(model=>model.id)).toEqual(['gpt-6.1-sol','moonshotai/kimi-k3']);
    const model=catalog.models[0];expect(model).toMatchObject({name:'GPT-6.1 Sol',provider:'openai',publisher:'openai',reasoningEfforts:['medium'],defaultReasoningEffort:'medium'});
    expect(model.routes?.map(route=>[route.source,route.modelId])).toEqual([['chatgpt','gpt-6.1-sol'],['openrouter','openai/gpt-6.1-sol']]);
    expect(model.routes?.[1].pricing).toEqual({input:3,output:15,cachedInput:.3});
    expect(model.routes?.map(route=>route.publisher)).toEqual(['openai','openai']);
    expect(catalog.models[1]).toMatchObject({provider:'openrouter',publisher:'moonshotai'});
  });
  it('never merges different versions by label and excludes latest aliases and non-agent models',()=>{
    const catalog=mergeModelCatalogs([{id:'openrouter',priority:10,catalog:router([
      rawRouter('openai/gpt-6.1-sol',{name:'Same name'}),rawRouter('openai/gpt-6.1-sol-20261001',{name:'Same name'}),
      rawRouter('~moonshotai/kimi-latest'),rawRouter('moonshotai/kimi-latest'),rawRouter('moonshotai/kimi-k3',{architecture:{input_modalities:['text'],output_modalities:['image']}}),
      rawRouter('lab/chat',{supported_parameters:[]}),rawRouter('openai/gpt-6.1-sol'),rawRouter('openai/gpt-6.1-sol:batch'),
    ])}],'gpt-6.1-sol');
    expect(catalog.models.map(model=>model.id)).toEqual(['gpt-6.1-sol','gpt-6.1-sol-20261001']);
    expect(parseBotInput({name:'Kimi',model:'moonshotai/kimi-k3'}).model).toBe('moonshotai/kimi-k3');
    expect(()=>parseBotInput({name:'Bad',model:'https://evil.test/model'})).toThrow();
    expect(()=>parseBotInput({name:'Bad',model:'lab/../../model'})).toThrow();
  });
  it('keeps healthy sources usable on partial failure and exposes failure rather than invented models',()=>{
    const catalog=mergeModelCatalogs([{id:'chatgpt',priority:0,catalog:{connected:true,models:[],defaultModel:'',error:'ChatGPT discovery unavailable'}},{id:'openrouter',priority:10,catalog:router([rawRouter('openai/gpt-6.1-sol')])}],'gpt-6.1-sol');
    expect(catalog).not.toHaveProperty('error');expect(catalog.models[0].provider).toBe('openrouter');expect(catalog.sources?.[0].error).toBeDefined();
    const disconnected=mergeModelCatalogs([{id:'chatgpt',priority:0,catalog:{...plan([subscription]),connected:false}}],'gpt-6.1-sol');expect(disconnected.models).toEqual([]);
    const custom=mergeModelCatalogs([{id:'another',priority:20,catalog:{connected:true,defaultModel:'',models:[{id:'custom/sol',canonicalId:'gpt-6.1-sol',name:'Sol',provider:'another',reasoningEfforts:[],supportsFast:false}]}}],'gpt-6.1-sol');
    expect(custom.models[0].routes?.[0]).toMatchObject({source:'another',modelId:'custom/sol'});
  });
});

describe('host-owned source discovery and transport',()=>{
  it('uses authenticated discovery, coalesces/cache reads, isolates key rotation, and validates router-only settings',async()=>{
    const server={OPENROUTER_API_KEY:'fixture-key-one'} as Env;
    const calls:{url:string;authorization:string|null}[]=[];
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{calls.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});return Response.json({data:[rawRouter('moonshotai/kimi-k3')]});});
    const catalogs=await Promise.all([modelCatalog(server),modelCatalog(server)]);
    expect(calls).toEqual([{url:'https://openrouter.ai/api/v1/models/user',authorization:'Bearer fixture-key-one'}]);
    expect(catalogs[0].models).toEqual(catalogs[1].models);expect(JSON.stringify(catalogs)).not.toContain('fixture-key');
    expect(await validateModelSettings(server,{model:'moonshotai/kimi-k3',reasoningEffort:'high'})).toEqual({model:'moonshotai/kimi-k3',reasoningEffort:'high',fast:false});
    await expect(validateModelSettings(server,{model:'missing'})).rejects.toMatchObject({code:'invalid_model_settings'});
    server.OPENROUTER_API_KEY='fixture-key-two';await modelCatalog(server);expect(calls).toHaveLength(2);
    delete server.OPENROUTER_API_KEY;expect((await modelCatalog(server)).models).toEqual([]);
  });
  it('rejects arbitrary endpoints and sanitizes discovery and billing failures',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('PRIVATE_PROVIDER_BODY',{status:402}));
    const catalog=await modelCatalog({OPENROUTER_API_KEY:'fixture'} as Env);expect(catalog.models).toEqual([]);expect(catalog.error).toBeDefined();expect(JSON.stringify(catalog)).not.toContain('PRIVATE');
    const response=await openRouterRequest({OPENROUTER_API_KEY:'fixture'} as Env,new Request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'PRIVATE_OWNER_TOKEN','x-private':'PRIVATE_HEADER'},body:'{}'}));
    expect(response.status).toBe(402);expect(await response.json()).toMatchObject({error:{code:'model_billing_required'}});
    const headers=new Headers(fetch.mock.calls.at(-1)?.[1]?.headers);expect(headers.get('authorization')).toBe('Bearer fixture');expect(headers.has('x-private')).toBe(false);
    await expect(openRouterRequest({OPENROUTER_API_KEY:'fixture'} as Env,new Request('https://evil.test/chat/completions',{method:'POST',body:'{}'}))).rejects.toThrow('Unsupported');
  });
});
