import { MAX_OUTPUT_CHARACTERS, TOOL_NAMESPACE } from '../src/chatgpt.js';

export const SHARED_ALLOWANCE_MESSAGE='The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.';

/** Wire-format OpenAI fixture. No model behavior, credentials, or Pi internals mocked. */
export function responsesFixture(payload: { input: Record<string, unknown>[] }, requestNumber = 1): Response {
  if (JSON.stringify(payload.input).includes('request-unfinished-stop')) return unfinishedStopResponse(payload.input);
  const userIndex = payload.input.map(item => item.role === 'user').lastIndexOf(true);
  const user = payload.input[userIndex];
  const text = JSON.stringify(user);
  if(text.includes('request-wire-allowance')) {
    const error={message:SHARED_ALLOWANCE_MESSAGE,...(text.includes('foreign-code')?{code:'unrecognized_fixture_usage_code'}:{})};
    const named=text.includes('named'),nested=text.includes('nested');
    const data=nested?{error}:named?error:{type:'response.failed',response:{id:'resp_allowance_fixture',status:'failed',output:[],error}};
    return new Response(`${named?'event: error\n':''}data: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }
  const serverFailure=text.includes('request-sse-server-error'),fastFailure=text.includes('request-sse-fast-error');
  const contextFailure=text.includes('request-sse-context-error')&&!JSON.stringify(payload.input).includes('<summary>');
  if(serverFailure||fastFailure||contextFailure) {
    const error={code:serverFailure?'server_error':fastFailure?'unsupported_value':'context_length_exceeded',...(fastFailure?{param:'service_tier'}:{}),message:'Private fixture provider details must not be projected.'};
    const event={type:'response.failed',response:{id:'resp_error_fixture',object:'response',status:'failed',output:[],error}};
    return new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }
  if (text.includes('request-resumable-exec') || text.includes('request-cancel-resumable-exec')) return resumableExecResponse(payload.input.slice(userIndex + 1), text.includes('request-cancel-resumable-exec'));
  if (text.includes('request-multistep-recovery')) return multistepResponse(payload.input.slice(userIndex + 1));
  if (text.includes('request-tool-budget')) return multistepResponse(payload.input.slice(userIndex + 1),'budget');
  if (text.includes('request-long-task')) return multistepResponse(payload.input.slice(userIndex + 1),'long');
  const hasToolOutput = payload.input.slice(userIndex + 1).some(item => item.type === 'function_call_output');
  if (hasToolOutput && (text.includes('empty-final-after-exec') || text.includes('recover-empty-once') && requestNumber === 2)) {
    const item = { type: 'reasoning', id: 'rs_empty_final', summary: [{ type: 'summary_text', text: 'Private fixture reasoning must remain hidden.' }], encrypted_content: 'synthetic-fixture-ciphertext' };
    const response = { id: 'resp_empty_final', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    const events = [
      { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  const spawn=text.includes('request-model-child')&&!hasToolOutput;
  const vision = text.includes('request-vision') && !hasToolOutput;
  const exec = text.includes('request-exec') && !hasToolOutput;
  const host = text.includes('request-host') && !hasToolOutput;
  const catalog = text.includes('request-catalog') && !hasToolOutput;
  const loop = text.includes('request-loop');
  const namespace = text.includes('bad-namespace') ? 'untrusted' : TOOL_NAMESPACE;
  const tool = spawn || vision || exec || loop || host || catalog || text.includes('bad-namespace');
  const name = spawn ? 'spawn_subagent' : host ? 'call_tool' : catalog ? 'list_tools' : vision ? 'desktop_screenshot' : loop ? 'read_file' : 'exec';
  const args = spawn ? JSON.stringify({name:'Model child',task:'hello child',...(text.includes('override')?{model:'gpt-6-astra',reasoningEffort:'ultra',fast:true}:{})}) : host ? '{"name":"github_clone","arguments":{"repository":"owner/private","path":"project"}}' : vision || catalog ? '{}' : loop ? '{"path":"/workspace/test.txt"}' : '{"command":"echo fixture"}';
  const failedTool = payload.input.slice(userIndex + 1).some(item=>item.type === 'function_call_output' && typeof item.output === 'string' && item.output.includes('"status":"failed"'));
  const answer = text.includes('output-limit') ? 'x'.repeat(MAX_OUTPUT_CHARACTERS + 1) : failedTool ? 'The command failed with exit 1. The saved output explains the failure.' : 'Hello from ChatGPT via the real Pi harness.';
  const finalItem = tool
    ? { type: 'function_call', id: 'fc_fixture_1', call_id: 'call_fixture_1', name, namespace, arguments: args, status: 'completed' }
    : { type: 'message', id: 'msg_fixture_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', output: [finalItem], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events: unknown[] = [
    { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...finalItem, arguments: '', status: 'in_progress' } : { ...finalItem, content: [], status: 'in_progress' } },
    tool ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: args } : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer },
    { type: 'response.output_item.done', output_index: 0, item: finalItem },
  ];
  if (text.includes('allowance-exhausted')) events.push({ type: 'response.failed', response: { ...response, status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Private account detail must not be projected.' } } });
  else if (hasToolOutput && text.includes('recover-incomplete-once') && requestNumber === 2) events.push({ type: 'response.incomplete', response: { ...response, status: 'incomplete', incomplete_details: { reason: 'server_error' } } });
  else if (text.includes('incomplete-response')) events.push({ type: 'response.incomplete', response: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
  else if (!text.includes('truncated-stream') && !(hasToolOutput && text.includes('recover-stream-once') && requestNumber === 2)) events.push({ type: 'response.completed', response });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function unfinishedStopResponse(history: Record<string, unknown>[]): Response {
  const toolResults=history.filter(item=>item.type==='function_call_output').length;
  const nudged=JSON.stringify(history).includes('[Timber internal continuation]');
  const call=toolResults===0?{name:'exec',arguments:{command:'echo fixture'}}:toolResults===1&&nudged?{name:'read_file',arguments:{path:'/workspace/test.txt'}}:undefined;
  const answer=toolResults===1&&!nudged
    ? 'La corrección sigue sin publicar. Falta validar y desplegar; ahora corresponde ejecutar la revisión.'
    : 'Validación y entrega completadas.';
  const item=call
    ? {type:'function_call',id:`fc_stop_${toolResults}`,call_id:`call_stop_${toolResults}`,name:call.name,namespace:TOOL_NAMESPACE,arguments:JSON.stringify(call.arguments),status:'completed'}
    : {type:'message',id:`msg_stop_${toolResults}`,role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:`resp_stop_${toolResults}`,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:8,total_tokens:18}};
  const events=[
    {type:'response.created',response:{...response,output:[],status:'in_progress'}},
    {type:'response.output_item.added',output_index:0,item:{...item,...(call?{arguments:''}:{content:[]}),status:'in_progress'}},
    call?{type:'response.function_call_arguments.delta',output_index:0,delta:JSON.stringify(call.arguments)}:{type:'response.output_text.delta',output_index:0,content_index:0,delta:answer},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response},
  ];
  return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}

/** The provider follows the process ID returned by the real runtime tool bridge. */
function resumableExecResponse(history: Record<string, unknown>[], cancel: boolean): Response {
  const results = history.filter(item => item.type === 'function_call_output');
  const previous = results.at(-1);
  const process = previous && typeof previous.output === 'string' ? JSON.parse(previous.output) as {processId?: string; status?: string} : undefined;
  const call = !process ? {name: 'exec', args: {command: 'fixture managed command'}}
    : process.status === 'running' ? {name: cancel ? 'exec_cancel' : 'exec_poll', args: {processId: process.processId, ...(cancel ? {} : {yieldMs: 0})}} : undefined;
  const answer = cancel ? 'The managed command was cancelled.' : 'The managed command completed.';
  const index = results.length;
  const item = call
    ? {type: 'function_call', id: `fc_process_${index}`, call_id: `call_process_${index}`, name: call.name, namespace: TOOL_NAMESPACE, arguments: JSON.stringify(call.args), status: 'completed'}
    : {type: 'message', id: 'msg_process_final', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: answer, annotations: []}]};
  const response = {id: `resp_process_${index}`, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}};
  const events = [
    {type: 'response.created', response: {...response, output: [], status: 'in_progress'}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, ...(call ? {arguments: ''} : {content: []}), status: 'in_progress'}},
    call ? {type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(call.args)} : {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}

/** Several tool rounds with commentary/reasoning and distinct composite call IDs. */
function multistepResponse(history: Record<string, unknown>[], mode: 'recovery' | 'budget' | 'long' = 'recovery'): Response {
  const completed = history.filter(item => item.type === 'function_call_output').length;
  const round = mode === 'long' ? completed / 2 : completed === 0 ? 0 : completed === 2 ? 1 : completed === 3 ? 2 : 3;
  const calls = mode === 'long' ? completed < 60 ? [0,1].map(index=>({name:'read_file',args:{path:`file-${completed+index}.txt`}})) : []
    : mode === 'budget' ? completed ? [] : Array.from({length:25},(_,index)=>({name:'read_file',args:{path:`file-${index}.txt`}})) : round === 0
    ? [{ name: 'exec', args: { command: 'printf fixture-one' } }, { name: 'exec', args: { command: 'printf fixture-two' } }]
    : round === 1 ? [{ name: 'browser_navigate', args: { url: 'https://example.test/fixture' } }]
    : round === 2 ? [{ name: 'desktop_screenshot', args: {} }] : [];
  const items: Record<string, unknown>[] = [
    { type: 'reasoning', id: `rs_multistep_${round}`, summary: [], encrypted_content: 'synthetic-fixture-ciphertext' },
    { type: 'message', id: `msg_multistep_${round}`, role: 'assistant', status: 'completed', phase: calls.length ? 'commentary' : 'final_answer', content: [{ type: 'output_text', text: calls.length ? `Working on fixture round ${round + 1}.` : mode === 'long' ? 'Completed 60 file reads over 30 tool rounds.' : mode === 'budget' ? 'I reached the tool limit; 24 reads completed. Continue to inspect more files.' : 'Completed both commands, opened the page, and checked the screenshot.', annotations: [] }] },
    ...calls.map((call, index) => ({ type: 'function_call', id: `fc_multistep_${round}_${index}`, call_id: `call_multistep_${round}_${index}`, name: call.name, namespace: TOOL_NAMESPACE, arguments: JSON.stringify(call.args), status: 'completed' })),
  ];
  const response = { id: `resp_multistep_${round}`, object: 'response', status: 'completed', output: items, usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } } };
  const events: Record<string, unknown>[] = [{ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } }];
  items.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'message' ? { content: [] } : {}), status: 'in_progress' } });
    if (item.type === 'function_call') {
      const argumentsText = item.arguments as string;
      const split = Math.floor(argumentsText.length / 2);
      for (const delta of [argumentsText.slice(0, split), argumentsText.slice(split)]) events.push({ type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta });
      events.push({ type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: argumentsText });
    } else if (item.type === 'message') {
      events.push({ type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: (item.content as { text: string }[])[0]!.text });
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response });
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
