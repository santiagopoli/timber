import {TOOL_NAMESPACE} from '../../packages/runtime/src/chatgpt';

/** Deterministic external model responses; all memory, tools and children use native Pi. */
export function maintenanceFixture(input:Record<string,unknown>[]):Response|undefined {
  const last=input.map(item=>item.role==='user').lastIndexOf(true),text=JSON.stringify(input[last]);
  const results=input.slice(last+1).filter(item=>item.type==='function_call_output');
  const parent=text.includes('request-parent-maintenance'),child=text.includes('request-child-maintenance');
  const recall=text.includes('request-recall-maintenance');
  if(!parent&&!child&&!recall)return undefined;
  const prior=results[0]?JSON.parse(String(results[0].output)):undefined;
  const calls=recall?[
    {name:'recall_history',args:{query:'Archive fact',limit:1}},
    {name:'recall_history',args:{query:'Archive fact',limit:1,before:prior?.nextCursor}},
  ]:parent?[{name:'spawn_subagent',args:{name:'Memory child',task:'request-child-maintenance'}}]:[
    {name:'memory_read',args:{}},
    {name:'memory_update',args:{content:'Child-specific verified fact.',revision:0}},
    {name:'memory_read',args:{}},
    {name:'recall_history',args:{query:'request-child-maintenance',limit:1}},
  ];
  const call=calls[results.length],answer=parent?'Memory child launched.':'Child memory retained; parent notes are read-only.';
  const item=call?{type:'function_call',id:`fc_memory_${results.length}`,call_id:`call_memory_${results.length}`,name:call.name,namespace:TOOL_NAMESPACE,arguments:JSON.stringify(call.args),status:'completed'}:{type:'message',id:'msg_memory',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_memory',object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:8,total_tokens:18}};
  const events=[
    {type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,...(call?{arguments:''}:{content:[]}),status:'in_progress'}},
    call?{type:'response.function_call_arguments.delta',output_index:0,delta:JSON.stringify(call.args)}:{type:'response.output_text.delta',output_index:0,content_index:0,delta:answer},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response},
  ];
  return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
