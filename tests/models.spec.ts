import {describe,expect,it} from 'vitest';
import {normalizeModelCatalog,resolveModelSettings,classifyModelFailure} from '@botspace/contracts';

describe('subscription allowance diagnostics',()=>{
  it('recognizes the production prose before generic HTTP rate limits without changing transient quota-independent errors',()=>{
    const message='The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.';
    for(const status of [undefined,400,429])expect(classifyModelFailure({status,message}).errorCode).toBe('chatgpt_allowance_exhausted');
    expect(classifyModelFailure({status:429,message:'ChatGPT rate limit reached: tokens per minute.'}).errorCode).toBe('model_rate_limited');
    expect(classifyModelFailure({status:429,message:'ChatGPT usage limit reached: requests per minute.'}).errorCode).toBe('model_rate_limited');
    expect(classifyModelFailure({message:'A tool reached its usage limit.'}).errorCode).toBe('model_request_failed');
    expect(classifyModelFailure({message:'Subscription Sharing is temporarily unavailable. Please retry your request.'}).errorCode).toBe('model_provider_unavailable');
  });
});

describe('account-scoped model choices',()=>{
  it('keeps provider order and future model/effort names while excluding non-list entries and duplicates',()=>{
    const models=normalizeModelCatalog({models:[
      {slug:'future-model-z',display_name:'Next model',visibility:'list',supported_reasoning_levels:[{effort:'adaptive'},{effort:'ultra.2'},{effort:'adaptive'}],default_reasoning_level:'ultra.2'},
      {slug:'hidden-model',visibility:'hide'},
      {slug:'unlisted-model'},
      {slug:'future-model-z',display_name:'Duplicate',visibility:'list'},
      {slug:'future-model-a',visibility:'list',supported_reasoning_levels:[{effort:'none'}],default_reasoning_level:'unsupported'},
    ]});
    expect(models.map(model=>model.id)).toEqual(['future-model-z','future-model-a']);
    expect(models[0]).toMatchObject({name:'Next model',reasoningEfforts:['adaptive','ultra.2'],defaultReasoningEffort:'ultra.2'});
    expect(resolveModelSettings({model:'future-model-z'},models)).toEqual({model:'future-model-z',reasoningEffort:'ultra.2',fast:false});
    expect(resolveModelSettings({model:'future-model-z',reasoningEffort:'adaptive'},models).reasoningEffort).toBe('adaptive');
    expect(models[1]).not.toHaveProperty('defaultReasoningEffort');
    expect(()=>resolveModelSettings({model:'hidden-model'},models)).toThrow('not available');
    expect(()=>resolveModelSettings({model:'future-model-z',reasoningEffort:'max'},models)).toThrow('not supported');
  });

  it('enables Fast only for advertised aliases and preserves the supported provider tier',()=>{
    const model=(slug:string,extra:Record<string,unknown>)=>({slug,visibility:'list',...extra});
    const models=normalizeModelCatalog({models:[
      model('fast',{service_tiers:[{id:'fast'}]}),
      model('priority',{service_tiers:[{id:'priority'}]}),
      model('legacy-speed',{additional_speed_tiers:['fast']}),
      model('ordinary',{service_tiers:[{id:'default'},{id:'flex'}],additional_speed_tiers:['slow']}),
    ]});
    expect(models.map(model=>[model.id,model.supportsFast,model.fastServiceTier])).toEqual([
      ['fast',true,'fast'],['priority',true,'priority'],['legacy-speed',true,'fast'],['ordinary',false,undefined],
    ]);
    expect(resolveModelSettings({model:'priority',fast:true},models).fast).toBe(true);
    expect(()=>resolveModelSettings({model:'ordinary',fast:true},models)).toThrow('Fast mode');
    expect(resolveModelSettings({model:'ordinary'},models)).toEqual({model:'ordinary',fast:false});
  });

  it('rejects API-key catalogues and includes only bounded public capability metadata',()=>{
    expect(()=>normalizeModelCatalog({data:[{id:'not-a-plan-model'}]})).toThrow('Invalid account');
    const [model]=normalizeModelCatalog({models:[{
      slug:'public-model',visibility:'list',display_name:'Visible',description:'Public description',
      context_window:1_000_000,max_output_tokens:128_000,input_modalities:['text','image','private-modality'],
      supports_reasoning_summary_parameter:false,account_id:'private-account',private_token:'private-token',
    }]});
    expect(model).toMatchObject({contextWindow:1_000_000,maxOutputTokens:128_000,inputModalities:['text','image'],supportsReasoningSummary:false});
    expect(JSON.stringify(model)).not.toMatch(/private-account|private-token|private-modality/);
  });
});
