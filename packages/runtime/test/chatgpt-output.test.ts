import {describe,expect,it} from 'vitest';
import type {Message} from '@earendil-works/pi-ai';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {isContextOverflow} from '@earendil-works/pi-ai/utils/overflow';
import {chatgptModel,createChatGPTProvider,MAX_OUTPUT_CHARACTERS,TOOL_NAMESPACE} from '../src/chatgpt.js';

type Item=Record<string,unknown>;
async function readEvents(events:Item[]) {
  const provider=createChatGPTProvider({fetch:async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})});
  const model={...chatgptModel,id:'gpt-6-astra',timberSettings:{model:'gpt-6-astra',reasoningEffort:'high',fast:true}};
  const stream=provider.streamSimple(model,{messages:[{role:'user',content:'Respond or call the given tool.',timestamp:0}]},{});
  for await(const _event of stream){}
  return stream.result();
}
async function result(items:Item[],deltas:Item[]=[]) {
  const response={id:'resp_size',object:'response',status:'completed',output:items,usage:{input_tokens:12,output_tokens:20,total_tokens:32}};
  const events:Item[]=[{type:'response.created',response:{...response,status:'in_progress',output:[]}}];
  for(const [index,item]of items.entries()) {
    events.push({type:'response.output_item.added',output_index:index,item:{...item,...(item.type==='message'?{content:[]}:item.type==='reasoning'?{summary:[],content:[],encrypted_content:undefined}:{arguments:''})}});
    events.push(...deltas.filter(event=>event.output_index===index));
    events.push({type:'response.output_item.done',output_index:index,item});
  }
  events.push({type:'response.completed',response});
  return readEvents(events);
}
const message=(text:string,id='msg_output'):Item=>({type:'message',id,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
const reasoning=(summary:string,encrypted=MAX_OUTPUT_CHARACTERS*2):Item=>({type:'reasoning',id:'rs_output',summary:[{type:'summary_text',text:summary}],encrypted_content:'x'.repeat(encrypted)});

describe('ChatGPT generated output limit',()=>{
  it('allows large encrypted reasoning while retaining its native signature and a short visible answer',async()=>{
    const response=await result([reasoning('A brief summary.'),message('Done.')]);
    expect(response.stopReason).toBe('stop');
    expect(response.content).toContainEqual(expect.objectContaining({type:'text',text:'Done.'}));
    const thought=response.content.find(part=>part.type==='thinking');
    expect(thought?.type==='thinking'&&JSON.parse(thought.thinkingSignature!).encrypted_content.length).toBe(MAX_OUTPUT_CHARACTERS*2);
  });
  it('does not count a final text snapshot twice after streamed deltas',async()=>{
    const text='x'.repeat(MAX_OUTPUT_CHARACTERS);
    const response=await result([message(text)],[{type:'response.output_text.delta',output_index:0,content_index:0,delta:text}]);
    expect(response.stopReason).toBe('stop');
  });
  it.each(['text','arguments','summary'])('rejects oversized generated %s before accepting a completed response',async kind=>{
    const text='x'.repeat(MAX_OUTPUT_CHARACTERS+1);
    const item=kind==='text'?message(text):kind==='summary'?reasoning(text):{type:'function_call',id:'fc_output',call_id:'call_output',namespace:TOOL_NAMESPACE,name:'exec',arguments:JSON.stringify({command:text}),status:'completed'};
    const response=await result([item]);
    expect(response.stopReason).toBe('aborted');expect(response.errorMessage).toContain('chatgpt_output_limit');
  });
  it('bounds the aggregate generated output even when all items arrive as final snapshots',async()=>{
    const response=await result([message('x'.repeat(40000),'msg_first'),message('y'.repeat(40000),'msg_second')]);
    expect(response.stopReason).toBe('aborted');expect(response.errorMessage).toContain('chatgpt_output_limit');
  });
});

describe('safe terminal SSE diagnostics',()=>{
  it.each([
    {type:'response.failed',code:'unsupported_value',param:'service_tier',expected:'model_fast_unsupported'},
    {type:'response.failed',code:'context_length_exceeded',param:'input',expected:'model_context_length_exceeded'},
    {type:'error',code:'server_error',param:undefined,expected:'model_provider_unavailable'},
    {type:'error',code:'invalid_encrypted_content',param:'input',expected:'model_history_invalid'},
    {type:'response.failed',code:'subscription_sharing_usage_limit_exceeded',param:undefined,expected:'chatgpt_allowance_exhausted'},
  ])('preserves $expected for HTTP 200 with $type without exposing provider text',async({type,code,param,expected})=>{
    const error={code,param,message:'PRIVATE PROVIDER DIAGNOSTIC sentinel-input-content'};
    const event=type==='response.failed'?{type,response:{id:'resp_error',object:'response',status:'failed',output:[],error}}:{type,...error};
    const response=await readEvents([event]);
    expect(response.stopReason).toBe('error');expect(response.errorMessage).toContain(expected);
    expect(isRetryableAssistantError(response)).toBe(expected==='model_provider_unavailable');
    expect(isContextOverflow(response)).toBe(expected==='model_context_length_exceeded');
    expect(JSON.stringify(response)).not.toContain('PRIVATE PROVIDER DIAGNOSTIC');expect(JSON.stringify(response)).not.toContain('sentinel-input-content');
  });
});

describe('native Responses tool namespace provenance',()=>{
  const call=(namespace:string|undefined)=>({type:'function_call',id:'fc_output',call_id:'call_output',namespace,name:'exec',arguments:'{}',status:'completed'});
  it('accepts namespace supplied at the completed tool item instead of the initial partial item',async()=>{
    const item=call(TOOL_NAMESPACE);
    const response=await readEvents([{type:'response.output_item.added',output_index:0,item:{...item,namespace:undefined,arguments:'',status:'in_progress'}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_late',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]);
    expect(response.stopReason).toBe('toolUse');expect(response.content).toContainEqual(expect.objectContaining({type:'toolCall',name:'exec',namespace:TOOL_NAMESPACE,arguments:{}}));
  });
  it.each(['initial','done'])('retains the host namespace confirmed in the %s event when later snapshots omit it',async confirmed=>{
    const item=call(TOOL_NAMESPACE),partial={...item,arguments:'',status:'in_progress'};
    const response=await readEvents([
      {type:'response.output_item.added',output_index:0,item:{...partial,namespace:confirmed==='initial'?TOOL_NAMESPACE:undefined}},
      {type:'response.output_item.done',output_index:0,item:{...item,namespace:confirmed==='done'?TOOL_NAMESPACE:undefined}},
      {type:'response.completed',response:{id:'resp_partial_namespace',status:'completed',output:[{...item,namespace:undefined}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
    ]);
    expect(response.stopReason).toBe('toolUse');expect(response.content).toContainEqual(expect.objectContaining({type:'toolCall',namespace:TOOL_NAMESPACE}));
  });
  it('rejects a conflicting explicit namespace or changed call identity after a valid host partial item',async()=>{
    for(const changed of [{namespace:'foreign'},{namespace:undefined,call_id:'call_different'}]) {
      const item=call(TOOL_NAMESPACE);
      const response=await readEvents([{type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},{type:'response.output_item.done',output_index:0,item:{...item,...changed}}]);
      expect(response.stopReason).toBe('error');expect(response.errorMessage).toContain('chatgpt_invalid_tool_namespace');
    }
  });
  it.each([undefined,'foreign'])('rejects an unconfirmed or foreign final tool namespace (%s)',async namespace=>{
    const response=await result([call(namespace)]);expect(response.stopReason).toBe('error');expect(response.errorMessage).toContain('chatgpt_invalid_tool_namespace');
  });
  it.each([{name:'retired_host_tool',namespace:TOOL_NAMESPACE,allowed:true},{name:'exec',namespace:'foreign',allowed:false},{name:'retired_host_tool',namespace:undefined,allowed:false}])('replays $name with original namespace $namespace only when provenance permits it',async({name,namespace,allowed})=>{
    const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const history:Message[]=[
      {role:'system',content:'',timestamp:0,toolsAdded:[{name:'exec',description:'Current host tool',parameters:{type:'object',properties:{}}}]},
      {role:'user',content:'Prior task',timestamp:0},
      {role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',usage,stopReason:'toolUse',timestamp:0,content:[{type:'toolCall',id:'call/original|fc_original',name,...(namespace===undefined?{}:{namespace}),arguments:{}}]},
      {role:'toolResult',toolCallId:'call/original|fc_original',toolName:name,content:[{type:'text',text:'Recorded completed result'}],isError:false,timestamp:0},
      {role:'user',content:'Continue using Astra',timestamp:0},
    ];
    const payloads:Item[]=[];
    const answer=message('Continued.'),completed={id:'resp_history',object:'response',status:'completed',output:[answer],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    const provider=createChatGPTProvider({fetch:async request=>{
      payloads.push(await request.json<Item>());
      return new Response([{type:'response.output_item.done',output_index:0,item:answer},{type:'response.completed',response:completed}].map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }});
    const stream=provider.streamSimple({...chatgptModel,id:'gpt-6-astra'},{messages:history},{});for await(const _event of stream){}
    const response=await stream.result();
    if(!allowed){expect(response.errorMessage).toContain('chatgpt_invalid_tool_namespace');expect(payloads).toEqual([]);return;}
    expect(response.stopReason).toBe('stop');expect(payloads).toHaveLength(1);
    expect(payloads[0]!.input).toContainEqual(expect.objectContaining({type:'function_call',call_id:'call_original',name,namespace:TOOL_NAMESPACE}));
    expect(JSON.stringify(payloads[0]!.tools)).not.toContain('retired_host_tool');
  });
});
