import {describe,expect,it,vi} from 'vitest';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import * as responses from '@earendil-works/pi-ai/api/openai-responses';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-responses';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {modelFailure} from '@botspace/contracts';
import {chatgptModel,createChatGPTProvider} from '../src/chatgpt.js';
import {classifyFailure} from '../src/normalize.js';
import {SHARED_ALLOWANCE_MESSAGE} from './responses-fixture.js';

type Shape='named'|'nested'|'response.failed'|'typed';
function quotaResponse(shape:Shape,code?:string) {
  const error={message:SHARED_ALLOWANCE_MESSAGE,...(code===undefined?{}:{code})};
  const data=shape==='nested'?{error}:shape==='response.failed'?{type:shape,response:{id:'resp_allowance',status:'failed',output:[],error}}:shape==='typed'?{type:'error',...error}:error;
  return new Response(`${shape==='named'?'event: error\n':''}data: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}});
}
const context={messages:[{role:'user' as const,content:'Hello',timestamp:0}]};
describe('ChatGPT subscription quota from actual SDK wire errors',()=>{
  it.each(['named','nested'] as const)('reproduces the SDK bypass of onProviderStreamEvent for %s errors',async shape=>{
    let observed=0;
    const stream=streamSimple(chatgptModel,context,{apiKey:'fixture',env:{},fetch:async()=>quotaResponse(shape),onProviderStreamEvent:()=>{observed++;},maxRetries:0});
    for await(const _event of stream){}
    expect((await stream.result()).errorMessage).toBe(SHARED_ALLOWANCE_MESSAGE);
    expect(observed).toBe(0);
  });
  it.each((['named','nested','response.failed','typed'] as const).flatMap(shape=>[undefined,'unrecognized_fixture_usage_code'].map(code=>({shape,code}))))('classifies $shape with code $code before native retry policy',async({shape,code})=>{
    let requests=0;
    const provider=createChatGPTProvider({fetch:async()=>{requests++;return quotaResponse(shape,code);}});
    const model={...chatgptModel,id:'gpt-6-astra',timberSettings:{model:'gpt-6-astra',reasoningEffort:'high',fast:true}};
    const stream=provider.streamSimple(model,context,{});
    const errors=[];
    for await(const event of stream)if(event.type==='error')errors.push(event.error);
    const response=await stream.result();
    expect(requests).toBe(1);expect(errors).toEqual([response]);
    expect(response.stopReason).toBe('error');
    expect(response.errorMessage).toBe(`chatgpt_allowance_exhausted: ${modelFailure('chatgpt_allowance_exhausted').publicMessage}`);
    expect(response.errorMessage).not.toContain('API key');
    expect(isRetryableAssistantError(response)).toBe(false);
  });
  it('reclassifies a historical prose-only native failure without exposing the provider suggestion',()=>{
    expect(classifyFailure('model_error',SHARED_ALLOWANCE_MESSAGE)).toEqual(modelFailure('chatgpt_allowance_exhausted'));
  });
  it.each(['throws','aborted','empty'] as const)('settles the adapter result when the SDK iterator %s',async mode=>{
    const source=createAssistantMessageEventStream();
    source[Symbol.asyncIterator]=async function*(){if(mode!=='empty')throw new Error('Fixture iterator failure');};
    const mocked=vi.spyOn(responses,'streamSimple').mockReturnValue(source);
    try {
      const controller=new AbortController();if(mode==='aborted')controller.abort();
      const provider=createChatGPTProvider({fetch:async()=>{throw new Error('No provider request expected');}});
      const stream=provider.streamSimple(chatgptModel,context,{signal:controller.signal});
      for await(const _event of stream){}
      const result=await stream.result();
      expect(result.stopReason).toBe(mode==='aborted'?'aborted':'error');
      expect(result.errorMessage).toBe(mode==='empty'?'chatgpt_incomplete_response: stream ended without a terminal response':'Fixture iterator failure');
    } finally {mocked.mockRestore();}
  });
});
