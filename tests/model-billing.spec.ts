import {describe,expect,it} from 'vitest';
import type {ModelOption,ModelRoute} from '@botspace/contracts';
import {modelUsage,modelBillingView} from '../apps/console/src/model-billing';

const route=(source:string,pricing?:ModelRoute['pricing'],extra:Partial<ModelRoute>={}):ModelRoute=>({id:'gpt-example',modelId:source==='openrouter'?'openai/gpt-example':'gpt-example',name:'GPT example',provider:source==='chatgpt'?'openai':source,source,reasoningEfforts:['medium','high'],supportsFast:false,contextWindow:128000,...(pricing?{pricing}:{}),...extra});
const model=(routes:ModelRoute[]):ModelOption=>({...routes[0],publisher:'openai',routes});
const view=(routes:ModelRoute[])=>modelBillingView(modelUsage(model(routes)),{model:'gpt-example',reasoningEffort:'medium'});

describe('model billing follows the admitted source rather than the creator',()=>{
  it('provides compact comparison values and complete route details without conflating plan and API rates',()=>{
    const usage=modelUsage(model([route('chatgpt'),route('openai-api',{input:2,output:10,cachedInput:.1}),route('openrouter',{input:3,output:15})]));
    const view=modelBillingView(usage,{model:'gpt-example',reasoningEffort:'medium'});
    expect(view.label).toBe('ChatGPT plan');expect(view.preview).toMatchObject({input:'$2',output:'$10',hint:'Fallback: OpenAI API'});
    expect(view.rows.map(row=>[row.source,row.status,row.fallback])).toEqual([['chatgpt','plan',false],['openai-api','priced',true],['openrouter','priced',true]]);
    expect(view.rows[1].cached).toBe('$0.1');expect(view.rows[0].input).toBeUndefined();
    expect(modelBillingView(modelUsage(model([route('chatgpt')]))).preview).toMatchObject({plan:true});
    expect(modelBillingView(modelUsage(model([route('openai-api',{input:2,output:10})]))).preview).toMatchObject({input:'$2',output:'$10'});
  });
  it('keeps an unknown first fallback unknown rather than quoting a cheaper later route',()=>{
    const view=modelBillingView(modelUsage(model([route('chatgpt'),route('openai-api'),route('openrouter',{input:1,output:2})])));
    expect(view.preview).toMatchObject({hint:'Fallback: OpenAI API',input:undefined,output:undefined});
    expect(view.rows[1].status).toBe('unknown');
  });
  it('does not show standard rates for Fast and exposes incompatible, paused and image billing states',()=>{
    const usage=modelUsage(model([route('chatgpt'),route('openai-api',{input:2,output:10},{supportsFast:true}),route('openrouter',{input:3,output:15})]));
    const fast=modelBillingView(usage,{model:'gpt-example',fast:true});
    expect(fast.rows[1]).toMatchObject({status:'fast',message:'Fast price unavailable'});expect(fast.rows[1].input).toBeUndefined();
    expect(fast.rows[2]).toMatchObject({status:'incompatible',message:'Fast unsupported'});
    expect(modelBillingView({...usage,blocked:true}).rows.every(row=>row.status==='paused'&&!row.input)).toBe(true);
    expect(modelBillingView({imageApi:true,routes:[]})).toMatchObject({label:'Image API',rows:[{status:'unknown'}]});
    expect(modelBillingView(modelUsage(model([route('openrouter',{input:0,output:0,cachedInput:0})]))).rows[0]).toMatchObject({input:'$0',output:'$0',cached:'$0'});
  });
  it('shows plan allowance without treating subscription tokens as free API credits',()=>{
    const result=view([route('chatgpt',{input:99,output:99})]);
    expect(result.rows[0]).toMatchObject({status:'plan',message:'Plan allowance'});expect(result.preview.input).toBeUndefined();expect(result.rows[0].input).toBeUndefined();
  });
  it('keeps distinct prices for paid routes of the same model',()=>{
    const result=view([route('openai-api',{input:2,output:10,cachedInput:.1}),route('openrouter',{input:3,output:15,cachedInput:.3})]);
    expect(result.label).toBe('OpenAI API');expect(result.rows[0]).toMatchObject({input:'$2',output:'$10',cached:'$0.1',fallback:false});
    expect(result.rows[1]).toMatchObject({input:'$3',output:'$15',cached:'$0.3',fallback:true});
  });
  it('distinguishes zero, small rates, missing prices and invalid prices',()=>{
    expect(view([route('openrouter',{input:0,output:0,cachedInput:0})]).rows[0]).toMatchObject({input:'$0',output:'$0',cached:'$0'});
    expect(view([route('openrouter',{input:.0000001,output:.0000002})]).rows[0]).toMatchObject({input:'$0.0000001',output:'$0.0000002'});
    for(const pricing of [undefined,{input:NaN,output:3},{input:2,output:Infinity},{input:-1,output:3}]){
      const result=view([route('openai-api',pricing)]);expect(result.rows[0].status).toBe('unknown');expect(result.preview.input).toBeUndefined();
    }
    expect(view([route('openrouter',{input:3,output:15})]).rows[0].cached).toBeUndefined();
  });
  it('does not advertise a fallback incompatible with reasoning or an unknown context capacity',()=>{
    const result=view([route('chatgpt'),route('openai-api',{input:2,output:10},{reasoningEfforts:['low']}),route('openrouter',{input:3,output:15},{contextWindow:undefined})]);
    expect(result.rows.slice(1).map(row=>[row.status,row.message])).toEqual([['incompatible','Reasoning unsupported'],['incompatible','Context unknown']]);
    expect(result.preview).toMatchObject({plan:true,input:undefined});
  });
  it('pauses paid prices while subscription discovery is unavailable',()=>{
    for(const source of ['openai-api','openrouter']){
      const entry=model([route(source,{input:2,output:10})]);
      const usage=modelUsage(entry,{models:[entry],connected:true,defaultModel:entry.id,sources:[{id:'chatgpt',connected:true,error:'temporarily unavailable'}]});
      expect(modelBillingView(usage)).toMatchObject({label:'Usage paused',rows:[{status:'paused'}],preview:{input:undefined}});
    }
  });
  it('keeps image billing separate and handles legacy account catalogues without guessing prices',()=>{
    expect(modelBillingView({routes:[],imageApi:true})).toMatchObject({label:'Image API',note:'Billed separately from ChatGPT',preview:{hint:'Separately billed'}});
    const legacy:ModelOption={id:'unknown',name:'Unknown',provider:'openai',publisher:'openai',supportsFast:false,reasoningEfforts:[]};
    expect(modelBillingView(modelUsage(legacy))).toMatchObject({label:'ChatGPT plan',rows:[{status:'plan'}]});
    expect(modelBillingView(modelUsage({...legacy,provider:'openai-api'}))).toMatchObject({label:'OpenAI API',rows:[{status:'unknown'}]});
    expect(modelBillingView(modelUsage({...legacy,provider:'unknown-transport'}))).toMatchObject({label:'unknown-transport',rows:[{status:'unknown'}]});
  });
});
