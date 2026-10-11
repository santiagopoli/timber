import {describe,expect,it} from 'vitest';
import {normalizeModelCatalog,normalizeOpenRouterCatalog} from '@botspace/contracts';
import {modelPublisherLabel} from '../apps/console/src/model-publisher';

const router=(id:string,name:string)=>normalizeOpenRouterCatalog({data:[{
  id,name,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools'],
}]})[0];

describe('catalogue model creators',()=>{
  it('retains the creator before OpenAI namespace canonicalization without changing inference routing',()=>{
    const model=router('openai/new-model','A new model');
    expect(model).toMatchObject({id:'new-model',publisher:'openai',provider:'openrouter'});
    expect(model.routes?.[0]).toMatchObject({modelId:'openai/new-model',publisher:'openai',source:'openrouter',provider:'openrouter'});
    expect(modelPublisherLabel(model)).toBe('OpenAI');
    expect(normalizeModelCatalog({models:[{slug:'new-model',visibility:'list'}]})[0].publisher).toBe('openai');
  });
  it('uses creator namespaces rather than model names or the OpenRouter transport',()=>{
    for(const [id,label] of [['anthropic','Anthropic'],['google','Google'],['meta-llama','Meta'],['moonshotai','Moonshot AI'],['mistralai','Mistral AI'],['qwen','Alibaba'],['unknown-new-lab','unknown-new-lab']]){
      const model=router(`${id}/new-model`,'OpenAI: GPT is a deliberately misleading test name');
      expect(model.publisher).toBe(id);expect(modelPublisherLabel(model)).toBe(label);
    }
  });
  it('supports older catalogues through concrete route IDs and never guesses the author of an unknown saved model',()=>{
    expect(modelPublisherLabel({id:'canonical-model',provider:'openrouter',routes:[{modelId:'openai/canonical-model'}]})).toBe('OpenAI');
    expect(modelPublisherLabel({id:'anthropic/new-model',provider:'openrouter'})).toBe('Anthropic');
    expect(modelPublisherLabel({id:'future-account-model',provider:'openai'})).toBe('OpenAI');
    expect(modelPublisherLabel({id:'unknown',provider:'openrouter'})).toBe('Other providers');
    expect(modelPublisherLabel({id:'gpt-fake-with-no-metadata'})).toBe('Other providers');
    expect(modelPublisherLabel({id:'ambiguous',publisher:'google',provider:'openrouter'})).toBe('Google');
  });
});
