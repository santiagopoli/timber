import { TOOL_NAMESPACE } from '../../packages/runtime/src/chatgpt';

export function steeringFixture(input: Record<string, unknown>[]): Response | undefined {
  const userIndex = input.map(item => item.role === 'user').lastIndexOf(true);
  const text = JSON.stringify(input[userIndex]);
  const first = text.includes('request-native-orchestrator'), second = text.includes('request-native-parallel-task');
  const child = text.includes('request-native-held-worker');
  if (!first && !second && !child) return;
  const results = input.slice(userIndex + 1).filter(item => item.type === 'function_call_output');
  const output = results[0]?.output;
  const childId = /"id"\s*:\s*"([^"\\]+)"/.exec(typeof output === 'string' ? output : JSON.stringify(output ?? ''))?.[1];
  let tool: {name: string; args: Record<string, unknown>} | undefined;
  if (!child && !results.length) tool = {name: 'spawn_subagent', args: {name: second ? 'Second worker' : 'First worker', task: `request-native-held-worker ${second ? 'second' : 'first'}`}};
  else if (first && results.length === 1) {
    if (!childId) throw new Error('The first worker has no returned identity');
    tool = {name: 'wait_subagent', args: {subagentId: childId}};
  }
  const phase = `${child ? 'child' : second ? 'second' : 'first'}_${results.length}`;
  const answer = child ? 'Worker task completed.' : second ? 'I assigned the new task to Second worker while First worker continues.' : 'The first worker finished.';
  const item = tool
    ? {type: 'function_call', id: `fc_steering_${phase}`, call_id: `call_steering_${phase}`, namespace: TOOL_NAMESPACE, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed'}
    : {type: 'message', id: `msg_steering_${phase}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: answer, annotations: []}]};
  const response = {id: `resp_steering_${phase}`, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}};
  const events = [
    {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, ...(tool ? {arguments: ''} : {content: []}), status: 'in_progress'}},
    tool ? {type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(tool.args)} : {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}
