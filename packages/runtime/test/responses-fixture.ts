import { MAX_OUTPUT_CHARACTERS, TOOL_NAMESPACE } from '../src/chatgpt.js';

/** Wire-format OpenAI fixture. No model behavior, credentials, or Pi internals mocked. */
export function responsesFixture(payload: { input: Record<string, unknown>[] }): Response {
  const userIndex = payload.input.findLastIndex(item => item.role === 'user');
  const user = payload.input[userIndex];
  const text = JSON.stringify(user);
  const hasToolOutput = payload.input.slice(userIndex + 1).some(item => item.type === 'function_call_output');
  const vision = text.includes('request-vision') && !hasToolOutput;
  const exec = text.includes('request-exec') && !hasToolOutput;
  const loop = text.includes('request-loop');
  const namespace = text.includes('bad-namespace') ? 'untrusted' : TOOL_NAMESPACE;
  const tool = vision || exec || loop || text.includes('bad-namespace');
  const name = vision ? 'desktop_screenshot' : loop ? 'read_file' : 'exec';
  const args = vision ? '{}' : loop ? '{"path":"/workspace/test.txt"}' : '{"command":"echo fixture"}';
  const answer = text.includes('output-limit') ? 'x'.repeat(MAX_OUTPUT_CHARACTERS + 1) : 'Hello from ChatGPT via the real Pi harness.';
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
  else if (text.includes('incomplete-response')) events.push({ type: 'response.incomplete', response: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
  else if (!text.includes('truncated-stream')) events.push({ type: 'response.completed', response });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
