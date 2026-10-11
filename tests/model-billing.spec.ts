import {describe,expect,it} from 'vitest';
import type {ModelOption,ModelRoute} from '@botspace/contracts';
import {modelUsage,modelBillingLines} from '../apps/console/src/model-billing';

const route=(source:string,pricing?:ModelRoute['pricing'],extra:Partial<ModelRoute>={}):ModelRoute=>({id:'gpt-example',modelId:source==='openrouter'?'openai/gpt-example':'gpt-example',name:'GPT example',provider:source==='chatgpt'?'openai':source,source,reasoningEfforts:['medium','high'],supportsFast:false,contextWindow:128000,...(pricing?{pricing}:{}),...extra});
const model=(routes:ModelRoute[]):ModelOption=>({...routes[0],publisher:'openai',routes});
const lines=(routes:ModelRoute[])=>modelBillingLines(modelUsage(model(routes)),{model:'gpt-example',reasoningEffort:'medium'});

describe('model billing follows the admitted source rather than the creator',()=>{
  it('shows subscription allowance without treating tokens as free API credits',()=>{
    const result=lines([route('chatgpt',{input:99,output:99})]);
    expect(result).toEqual(['Uses ChatGPT allowance · No per-token API charge']);
    expect(result.join(' ')).not.toContain('$');
  });
  it('keeps distinct paid prices and the fallback order for the exact same model',()=>{
    const result=lines([route('chatgpt'),route('openai-api',{input:2,output:10,cachedInput:.1}),route('openrouter',{input:3,output:15,cachedInput:.3})]);
    expect(result).toEqual(['Uses ChatGPT allowance · No per-token API charge','OpenAI API fallback · USD / 1M tokens','Input $2 · Output $10 · Cached input $0.1','OpenRouter fallback · USD / 1M tokens','Input $3 · Output $15 · Cached input $0.3']);
    expect(modelBillingLines(modelUsage(model([route('chatgpt'),route('openai-api',{input:2,output:10}),route('openrouter',{input:3,output:15})])),undefined,true)).toEqual(['Uses ChatGPT allowance · No per-token API charge','OpenAI API fallback · Input $2 · Output $10 / 1M tokens (USD)']);
    const paid=lines([route('openai-api',{input:2,output:10}),route('openrouter',{input:3,output:15})]);
    expect(paid[0]).toBe('OpenAI API · USD / 1M tokens');expect(paid.join(' ')).not.toContain('ChatGPT');
  });
  it('handles zero rates, very small prices and missing/invalid prices distinctly',()=>{
    expect(lines([route('openrouter',{input:0,output:0,cachedInput:0})]).join(' ')).toContain('Input $0 · Output $0 · Cached input $0');
    expect(lines([route('openrouter',{input:.0000001,output:.0000002})]).join(' ')).toContain('Input $0.0000001 · Output $0.0000002');
    for(const pricing of [undefined,{input:NaN,output:3},{input:2,output:Infinity},{input:-1,output:3}])expect(lines([route('openai-api',pricing)])).toEqual(['OpenAI API · Token pricing unavailable']);
    expect(lines([route('openrouter',{input:3,output:15})]).join(' ')).not.toContain('Cached input');
  });
  it('does not advertise a paid fallback incompatible with Fast or reasoning',()=>{
    const usage=modelUsage(model([route('chatgpt'),route('openai-api',{input:2,output:10}),route('openrouter',{input:3,output:15},{reasoningEfforts:['low']})]));
    expect(modelBillingLines(usage,{model:'gpt-example',fast:true}).slice(1)).toEqual(['OpenAI API fallback unavailable with these settings','OpenRouter fallback unavailable with these settings']);
    expect(modelBillingLines(usage,{model:'gpt-example',reasoningEffort:'high'}).at(-1)).toBe('OpenRouter fallback unavailable with these settings');
    const fast=route('openai-api',{input:2,output:10},{supportsFast:true});
    expect(modelBillingLines(modelUsage(model([fast])),{model:'gpt-example',fast:true}).at(-1)).toContain('Standard rates; Fast pricing unavailable');
  });
  it('marks paid discovery as paused while subscription discovery is unavailable',()=>{
    for(const source of ['openai-api','openrouter']){
      const entry=model([route(source,{input:2,output:10})]);
      const usage=modelUsage(entry,{models:[entry],connected:true,defaultModel:entry.id,sources:[{id:'chatgpt',connected:true,error:'temporarily unavailable'}]});
      expect(modelBillingLines(usage)).toEqual(['Paid inference paused until the ChatGPT catalogue refreshes']);
    }
    expect(lines([route('chatgpt'),route('openrouter',{input:3,output:15},{contextWindow:undefined})]).at(-1)).toBe('OpenRouter fallback unavailable: context capacity unknown');
  });
  it('keeps image API billing separate and supports older account catalogues without guessing prices',()=>{
    expect(modelBillingLines({routes:[],imageApi:true})).toEqual(['OpenAI Image API · Separately billed','Token pricing unavailable']);
    const legacy:ModelOption={id:'unknown',name:'Unknown',provider:'openai',publisher:'openai',supportsFast:false,reasoningEfforts:[]};
    expect(modelBillingLines(modelUsage(legacy))).toEqual(['Uses ChatGPT allowance · No per-token API charge']);
    expect(modelBillingLines(modelUsage({...legacy,provider:'openai-api'}))).toEqual(['OpenAI API · Token pricing unavailable']);
    expect(modelBillingLines(modelUsage({...legacy,provider:'unknown-transport'}))).toEqual(['unknown-transport · Token pricing unavailable']);
  });
});
