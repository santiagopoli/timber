import { describe, expect, it, vi } from 'vitest';
import type { EntryRecord, ToolExecutionApi } from '@earendil-works/pi-durable';
import { classifyFailure, normalizeEntries, textContent, toolCompletion } from '../src/normalize.js';
import { computerToolOperationId, computerTools, executeComputerTool, executeHostTool, hostTools, type ToolBridge } from '../src/tools.js';
import type { RuntimePause } from '../src/types.js';
import { chatgptModel, chatgptPayload, createChatGPTProvider } from '../src/chatgpt.js';
import { createModels } from '@earendil-works/pi-ai/models';

const api = { taskId: 'task-17', callId: 'call-42' } as unknown as ToolExecutionApi;
const context = { name: 'test', abortSignal: new AbortController().signal, get: () => undefined } as unknown as Parameters<ToolExecutionApi['agent']>[0];
function bridge(): ToolBridge {
  return {
    operationForCall: vi.fn(async () => 'user-operation'),
    consume: vi.fn(),
    tools: { execute: vi.fn(async ({ operationId }) => ({ operationId, status: 'completed' as const })) },
  };
}

describe('computer tool operation identity', () => {
  it('preserves already-valid legacy identities, including the 160-character boundary', async () => {
    for (const callId of ['call-42', 'a:b.c_d-9', 'a'.repeat(160 - 'pi-tool:17:'.length)]) {
      expect(await computerToolOperationId('17', callId)).toBe(`pi-tool:17:${callId}`);
    }
  });
  it.each([
    'call_SyntheticCompositeAb12|fc_0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    'call/with/slashes', 'call_漢字_ñ', 'a'.repeat(200), 'call-with-final-newline\n',
  ])('maps an opaque call to a stable bounded identity: %s', async callId => {
    const result = await computerToolOperationId('12', callId);
    expect(result).toMatch(/^pi-tool-sha256:[a-f0-9]{64}$/);
    expect(result).toMatch(/^[A-Za-z0-9:_.-]{1,160}$/);
    expect(await computerToolOperationId('12', callId)).toBe(result);
  });
  it('keeps delimiter variants, tuple boundaries and oversized suffixes distinct', async () => {
    const inputs = [
      ['17', 'a/b'], ['17', 'a|b'], ['17', 'a_b'],
      ['17:a', 'b/c'], ['17', 'a:b/c'],
      ['17', 'a'.repeat(200) + 'b'], ['17', 'a'.repeat(200) + 'c'],
      ['17', 'call_漢字'], ['18', 'call_漢字'],
    ];
    const results = await Promise.all(inputs.map(([taskId, callId]) => computerToolOperationId(taskId!, callId!)));
    expect(new Set(results).size).toBe(inputs.length);
    const hash = await computerToolOperationId('17', 'a/b');
    const legacy = await computerToolOperationId('sha256', hash.split(':')[1]!);
    expect(legacy).toBe(`pi-tool:sha256:${hash.split(':')[1]}`);
    expect(legacy).not.toBe(hash);
  });
});

describe('runtime computer bridge', () => {
  it('stops the native run on pending approval without executing a second operation', async () => {
    const host = bridge();
    host.tools.execute = vi.fn(async () => ({ status: 'pending_approval' as const, approvalId: 'approval-1' }));
    const action = { type: 'exec' as const, command: 'echo hello' };
    const result = await executeComputerTool(host, action, api, context);
    expect(result.control).toEqual({ terminate: true });
    expect(host.tools.execute).toHaveBeenCalledTimes(1);
    expect(host.tools.execute).toHaveBeenCalledWith({ operationId: 'pi-tool:task-17:call-42', runOperationId: 'user-operation', toolCallId: api.callId, action, signal: context.abortSignal });
  });
  it('preserves the operation id across replay of a safe tool', async () => {
    const host = bridge();
    await executeComputerTool(host, { type: 'readFile', path: '/workspace/a' }, api, context);
    await executeComputerTool(host, { type: 'readFile', path: '/workspace/a' }, api, context);
    const calls = vi.mocked(host.tools.execute).mock.calls;
    expect(calls[0]?.[0].operationId).toBe(calls[1]?.[0].operationId);
  });
  it('uses the same bounded composite identity for the tool budget and replayed dispatch', async () => {
    const host = bridge();
    const compositeApi = { ...api, taskId: '12', callId: 'call_SyntheticCompositeAb12|fc_0123456789abcdef0123456789abcdef0123456789abcdef01234567' } as unknown as ToolExecutionApi;
    const action = { type: 'readFile' as const, path: '/workspace/a' };
    await executeComputerTool(host, action, compositeApi, context);
    await executeComputerTool(host, action, compositeApi, context);
    const operationId = await computerToolOperationId('12', compositeApi.callId);
    expect(host.consume).toHaveBeenNthCalledWith(1, 'user-operation', 'tool', operationId);
    expect(host.consume).toHaveBeenNthCalledWith(2, 'user-operation', 'tool', operationId);
    for (const [input] of vi.mocked(host.tools.execute).mock.calls) {
      expect(input).toEqual({ operationId, runOperationId: 'user-operation', toolCallId: compositeApi.callId, action, signal: context.abortSignal });
    }
  });
  it('refuses dispatch after the durable tool budget is exhausted', async () => {
    const host = bridge();
    host.consume = () => { throw new Error('budget exceeded'); };
    const result = await executeComputerTool(host, { type: 'screenshot' }, api, context);
    expect(host.tools.execute).not.toHaveBeenCalled();
    expect(result.control).toBeUndefined(); // The model must be able to explain the limit.
    expect(result.isError).toBe(true);
  });
  it('returns screenshot pixels to the model, not just an artifact identifier', async () => {
    const host = bridge();
    host.tools.execute = vi.fn(async ({ operationId }) => ({ operationId, status: 'completed' as const, artifactId: 'image.png' }));
    host.tools.readImage = vi.fn(async () => ({ data: 'aW1hZ2U=', mimeType: 'image/png' }));
    const result = await executeComputerTool(host, { type: 'screenshot' }, api, context);
    expect(result.content?.[1]).toEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
  });
  it('does not dispatch visual tools when the configured model cannot see images', async () => {
    const host = bridge();
    host.imageInputSupported = async () => false;
    const result = await executeComputerTool(host, { type: 'screenshot' }, api, context);
    expect(result.isError).toBe(true);
    expect(host.tools.execute).not.toHaveBeenCalled();
  });
  it('marks side-effecting tools unsafe for crash recovery', () => {
    const tools = computerTools(bridge());
    for (const name of ['exec', 'exec_cancel', 'write_file', 'browser_navigate', 'desktop_click', 'desktop_move', 'desktop_double_click', 'desktop_drag', 'desktop_type', 'desktop_key', 'desktop_scroll']) {
      expect(tools.find(tool => tool.name === name)?.replay).toBe('unsafe');
    }
    expect(tools.find(tool => tool.name === 'read_file')?.replay).toBe('safe');
    expect(tools.find(tool => tool.name === 'exec_poll')?.replay).toBe('safe');
  });
  it('passes mouse gestures through the same sequential host approval and operation boundary', async () => {
    const host = bridge();
    const tools = computerTools(host);
    const gestures = [
      {name: 'desktop_move', input: {x: 200, y: 350}, action: {type: 'move', x: 200, y: 350}},
      {name: 'desktop_double_click', input: {x: 90, y: 60, button: 'right'}, action: {type: 'doubleClick', x: 90, y: 60, button: 'right'}},
      {name: 'desktop_drag', input: {fromX: 90, fromY: 60, toX: 500, toY: 400, durationMs: 750}, action: {type: 'drag', fromX: 90, fromY: 60, toX: 500, toY: 400, durationMs: 750}},
    ];
    for(const gesture of gestures) {
      const tool = tools.find(tool => tool.name === gesture.name)!;
      expect(tool.executionMode).toBe('sequential');
      await tool.execute(gesture.input, api, context);
      expect(host.tools.execute).toHaveBeenLastCalledWith(expect.objectContaining({action: gesture.action, toolCallId: api.callId, runOperationId: 'user-operation', signal: context.abortSignal}));
    }
  });
  it('keeps an omitted execution deadline absent and preserves long deadlines separately from yield', async () => {
    const host = bridge();
    const exec = computerTools(host).find(tool => tool.name === 'exec')!;
    await exec.execute({command: 'install dependencies'}, api, context);
    expect(vi.mocked(host.tools.execute).mock.calls[0]?.[0].action).toEqual({type: 'exec', command: 'install dependencies', yieldMs: 1000});
    await exec.execute({command: 'long build', timeoutMs: 900000, yieldMs: 0}, api, context);
    expect(vi.mocked(host.tools.execute).mock.calls[1]?.[0].action).toEqual({type: 'exec', command: 'long build', timeoutMs: 900000, yieldMs: 0});
    const properties = exec.parameters.properties as Record<string, unknown>;
    expect(properties.timeoutMs).toMatchObject({minimum: 1, maximum: Number.MAX_SAFE_INTEGER});
    expect(properties.timeoutMs).not.toHaveProperty('default');
  });
  it('polls and cancels only the supplied process while retaining independent invocation identities', async () => {
    const host = bridge(), tools = computerTools(host), processId = 'pi-tool:original:exec';
    const poll = tools.find(tool => tool.name === 'exec_poll')!;
    const cancel = tools.find(tool => tool.name === 'exec_cancel')!;
    await poll.execute({processId}, api, context);
    await poll.execute({processId, yieldMs: 30000}, {...api, callId: 'poll-next'}, context);
    await cancel.execute({processId}, {...api, callId: 'cancel-process'}, context);
    const calls = vi.mocked(host.tools.execute).mock.calls.map(([request]) => request);
    expect(calls.map(call => call.action)).toEqual([
      {type: 'execPoll', processId, yieldMs: 1000},
      {type: 'execPoll', processId, yieldMs: 30000},
      {type: 'execCancel', processId},
    ]);
    expect(new Set(calls.map(call => call.operationId)).size).toBe(3);
  });
  it.each(['running', 'cancelled'] as const)('returns process state %s without failing or pausing the Pi turn', async status => {
    const host = bridge();
    host.tools.execute = vi.fn(async ({operationId}) => ({operationId, processId: 'process-1', status, output: 'retained output'}));
    const result = await executeComputerTool(host, {type: status === 'running' ? 'execPoll' : 'execCancel', processId: 'process-1'}, api, context);
    expect(result.isError).toBe(false);
    expect(result.control).toBeUndefined();
    expect(JSON.parse(textContent(result.content))).toMatchObject({status, processId: 'process-1', output: 'retained output'});
  });
});

describe('runtime host tool bridge', () => {
  it('only advertises host tools when both discovery and dispatch exist', () => {
    const host = bridge();
    expect(hostTools(host)).toEqual([]);
    host.tools.catalog = async () => [];
    expect(hostTools(host)).toEqual([]);
    host.tools.call = vi.fn(async ({ operationId }) => ({ operationId, status: 'completed' as const }));
    expect(hostTools(host).map(tool => [tool.name, tool.replay])).toEqual([['list_tools', 'safe'], ['call_tool', 'unsafe']]);
    expect(hostTools(host)[1]?.executionMode).toBe('sequential');
  });
  it('passes stable host identities without starting the computer or altering arguments', async () => {
    const host = bridge();
    host.tools.call = vi.fn(async ({ operationId }) => ({ operationId, status: 'completed' as const, output: 'repository checked' }));
    const input = { name: 'github_clone', arguments: { repository: 'owner/repo', path: 'project' } };
    const result = await executeHostTool(host, input, api, context);
    expect(host.tools.call).toHaveBeenCalledWith({ ...input, operationId: 'pi-tool:task-17:call-42', runOperationId: 'user-operation', toolCallId: api.callId, signal: context.abortSignal });
    expect(host.tools.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });
  it('persists a connection pause and prevents any remaining host or computer dispatch in that run', async () => {
    const host = bridge();
    const pending: RuntimePause = { status: 'pending_connection', requestId: 'connect-1', provider: 'github', repository: 'owner/private', permission: 'write' };
    host.tools.call = vi.fn(async () => pending);
    let saved: RuntimePause | undefined;
    host.pause = vi.fn((_operationId, result) => { saved = result; });
    host.paused = () => saved;
    const result = await executeHostTool(host, { name: 'github_clone', arguments: { repository: 'owner/private' } }, api, context);
    expect(result.control).toEqual({ terminate: true });
    expect(host.pause).toHaveBeenCalledWith('user-operation', pending);
    await executeHostTool(host, { name: 'github_push', arguments: {} }, api, context);
    await executeComputerTool(host, { type: 'exec', command: 'git clone forbidden-fallback' }, api, context);
    expect(host.tools.call).toHaveBeenCalledTimes(1);
    expect(host.tools.execute).not.toHaveBeenCalled();
    expect(host.consume).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation and the durable budget before calling a host service', async () => {
    const host = bridge();
    host.tools.call = vi.fn(async ({ operationId }) => ({ operationId, status: 'completed' as const }));
    const abort = new AbortController();
    abort.abort();
    await expect(executeHostTool(host, { name: 'github_push', arguments: {} }, api, { ...context, abortSignal: abort.signal })).rejects.toThrow();
    host.consume = () => { throw new Error('exhausted'); };
    expect(await executeHostTool(host, { name: 'github_push', arguments: {} }, api, context)).toMatchObject({isError:true});
    expect(host.tools.call).not.toHaveBeenCalled();
  });
});

describe('public transcript projection', () => {
  it('classifies public tool-call commentary and final answers from native metadata only', () => {
    const entries = [{ id: '12', conversationId: '1', kind: 'assistant', model: [
      { role: 'assistant', content: [{ type: 'text', text: 'Same words' }, { type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'private command' } }], stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'text', text: 'Same words' }], stopReason: 'stop' },
      { role: 'assistant', content: [{ type: 'text', text: 'Unfinished attempt' }], stopReason: 'error' },
    ] }] as unknown as EntryRecord[];
    expect(normalizeEntries(entries).map(message => message.kind)).toEqual(['progress', 'final']);
    expect(JSON.stringify(normalizeEntries(entries))).not.toContain('Unfinished attempt');
    expect(JSON.stringify(normalizeEntries(entries))).not.toContain('private command');
  });
  it('projects honest tool status and correlation without tool output or arguments', () => {
    const entry = { model: [{ role: 'toolResult', toolCallId: 'call1', toolName: 'exec', content: [{ type: 'text', text: JSON.stringify({ operationId: 'pi-tool:12:call1', status: 'pending_approval', output: 'private output' }) }] }] } as unknown as EntryRecord;
    expect(toolCompletion(entry)).toEqual({ operationId: 'pi-tool:12:call1', status: 'pending_approval' });
    expect(toolCompletion({ model: [{ role: 'toolResult', isError: true, content: [{ type: 'text', text: 'Validation detail' }] }] } as unknown as EntryRecord)).toEqual({ status: 'failed' });
  });
  it('projects a pending connection without disclosing its repository or request payload', () => {
    const entry = { model: [{ role: 'toolResult', content: [{ type: 'text', text: JSON.stringify({ operationId: 'host:1', status: 'pending_connection', repository: 'owner/private', arguments: { private: true } }) }] }] } as unknown as EntryRecord;
    expect(toolCompletion(entry)).toEqual({ operationId: 'host:1', status: 'pending_connection' });
  });
  it.each(['running', 'cancelled'])('projects resumable exec %s and a bounded process ID without command output', status => {
    const entry = {model: [{role: 'toolResult', content: [{type: 'text', text: JSON.stringify({operationId: 'poll:1', processId: 'exec:1', status, output: 'private output'})}]}]} as unknown as EntryRecord;
    expect(toolCompletion(entry)).toEqual({operationId: 'poll:1', processId: 'exec:1', status});
    const invalid = {model: [{role: 'toolResult', content: [{type: 'text', text: JSON.stringify({processId: 'invalid\nprocess', status})}]}]} as unknown as EntryRecord;
    expect(toolCompletion(invalid)).toEqual({status});
  });
  it('does not serialize private reasoning, tool arguments, or image payloads as text', () => {
    expect(textContent([{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'Answer' }, { type: 'image', data: 'secret-pixels' }])).toBe('Answer');
  });
  it('uses stable message identities for restart reconciliation', () => {
    const entries = [{ id: '12', conversationId: '1', kind: 'assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Saved' }], timestamp: 0 }] }] as unknown as EntryRecord[];
    expect(normalizeEntries(entries)).toEqual([{ id: 'pi:12:0', role: 'assistant', text: 'Saved', createdAt: '1970-01-01T00:00:00.000Z' }]);
  });
});


describe('safe inference failure classification', () => {
  it('reports paid model access without exposing the upstream error body', () => {
    const result = classifyFailure('model_error', 'This model requires a Workers Paid plan. Body contains private user material.');
    expect(result.errorCode).toBe('model_billing_required');
    expect(JSON.stringify(result)).not.toContain('private user material');
  });
  it('keeps unknown provider failures generic', () => {
    const result = classifyFailure('model_error', 'secret-value 123');
    expect(result.errorCode).toBe('model_request_failed');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});

describe('ChatGPT subscription boundary', () => {
  it('fails without a host connection and never uses global fetch or an API key fallback', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
    try {
      const provider = createChatGPTProvider(undefined);
      const models = createModels();
      models.setProvider(provider);
      const stream = models.streamSimple(chatgptModel, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] });
      const result = await stream.result();
      expect(result.stopReason).toBe('error');
      expect(classifyFailure('model_error', result.errorMessage).errorCode).toBe('chatgpt_not_connected');
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('removes unsupported SDK fields and rejects foreign tool namespaces', () => {
    const payload = chatgptPayload({ input: [{ role: 'system', content: 'Instruction' }], model: 'other', max_output_tokens: 7, previous_response_id: 'old', metadata: { private: true }, tools: [] });
    expect(payload).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, input: [{ role: 'developer', content: 'Instruction' }] });
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('max_output_tokens');
    expect(payload).not.toHaveProperty('previous_response_id');
    expect(() => chatgptPayload({ input: [{ type: 'function_call', namespace: 'other' }] })).toThrow('chatgpt_invalid_tool_namespace');
  });
});
