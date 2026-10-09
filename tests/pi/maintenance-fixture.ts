import {TOOL_NAMESPACE} from '../../packages/runtime/src/chatgpt';

/** Deterministic external model responses; all memory, tools and children use native Pi. */
export function maintenanceFixture(input:Record<string,unknown>[]):Response|undefined {
  const last=input.map(item=>item.role==='user').lastIndexOf(true),text=JSON.stringify(input[last]);
  if(JSON.stringify(input).includes('TIMBER_MEMORY_REVIEW_V1'))return reviewFixture(input[last]);
  const results=input.slice(last+1).filter(item=>item.type==='function_call_output');
  const parent=text.includes('request-parent-maintenance'),child=text.includes('request-child-maintenance');
  const recall=text.includes('request-recall-maintenance');
  if(!parent&&!child&&!recall)return undefined;
  const prior=results[0]?JSON.parse(String(results[0].output)):undefined;
  const listed=results[1]?JSON.parse(String(results[1].output)):undefined;
  const saved=results[2]?JSON.parse(String(results[2].output)):undefined;
  const calls=recall?[
    {name:'recall_history',args:{query:'Archive fact',limit:1}},
    {name:'recall_history',args:{query:'Archive fact',limit:1,before:prior?.nextCursor}},
  ]:parent?[{name:'spawn_subagent',args:{name:'Memory child',task:'request-child-maintenance: This child uses concise notes.'}}]:[
    {name:'recall_history',args:{query:'request-child-maintenance',limit:1}},
    {name:'memory_read',args:{}},
    {name:'memory_save',args:{category:'fact',title:'Child note style',content:'This child uses concise notes.',sources:[{messageId:prior?.messages?.[0]?.id,quote:'This child uses concise notes.'}]}},
    {name:'memory_read',args:{}},
    {name:'memory_get',args:{id:saved?.entry?.id}},
    {name:'memory_get',args:{id:listed?.inherited?.entries?.[0]?.id,scope:'inherited'}},
  ];
  const call=calls[results.length],answer=parent?'Memory child launched.':'Child memory suggestion retained; parent notes are read-only.';
  return modelResponse(answer,call,results.length);
}

function reviewFixture(user:Record<string,unknown>|undefined):Response {
  const blocks=user?.content;
  const text=typeof blocks==='string'?blocks:Array.isArray(blocks)?blocks.map(block=>typeof block==='object'&&block&&'text'in block?String(block.text):'').join('\n'):'';
  let payload:{messages?:{id:string;role:string;text:string}[];existing?:{id:string}[]}={};
  try{payload=JSON.parse(text);}catch{}
  const messages=payload.messages??[];
  if(messages.some(message=>message.text.includes('review-memory-fail-fixture'))){
    return Response.json({error:{code:'server_error',message:'Deliberate memory review failure fixture.'}},{status:503});
  }
  const pageSources=messages.filter(message=>message.role==='user'&&message.text.includes('review-page-fixture:'));
  if(pageSources.length){
    const candidates=pageSources.map(source=>{const quote=source.text.split('review-page-fixture:')[1]!.trim();return {category:'fact',title:quote.split(' uses ')[0],content:quote,sources:[{messageId:source.id,quote}]};});
    return modelResponse(JSON.stringify({candidates}));
  }
  const correction=messages.find(message=>message.role==='user'&&message.text.includes('review-correction-fixture:'));
  const source=correction??messages.find(message=>message.role==='user'&&message.text.includes('review-memory-fixture:'));
  const quote=correction?'The user now prefers responses in English.':'The user prefers concise Spanish responses.';
  const candidates=source?[{category:'preference',title:'Response preferences',content:quote,sources:[{messageId:source.id,quote}],...(correction&&payload.existing?.[0]?{replacesId:payload.existing[0].id}:{})}]:[];
  return modelResponse(JSON.stringify({candidates}));
}

function modelResponse(answer:string,call?:{name:string;args:unknown},index=0):Response {
  const item=call?{type:'function_call',id:`fc_memory_${index}`,call_id:`call_memory_${index}`,name:call.name,namespace:TOOL_NAMESPACE,arguments:JSON.stringify(call.args),status:'completed'}:{type:'message',id:'msg_memory',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
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
