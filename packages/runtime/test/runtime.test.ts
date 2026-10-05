import { describe, expect, it, vi } from 'vitest';
import type { EntryRecord, ToolExecutionApi } from '@earendil-works/pi-durable';
import { classifyFailure, normalizeEntries, textContent } from '../src/normalize.js';
import { computerTools, executeComputerTool, type ToolBridge } from '../src/tools.js';
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

describe('runtime computer bridge', () => {
  it('stops the native run on pending approval without executing a second operation', async () => {
    const host = bridge();
    host.tools.execute = vi.fn(async () => ({ status: 'pending_approval' as const, approvalId: 'approval-1' }));
    const action = { type: 'exec' as const, command: 'echo hello' };
    const result = await executeComputerTool(host, action, api, context);
    expect(result.control).toEqual({ terminate: true });
    expect(host.tools.execute).toHaveBeenCalledTimes(1);
    expect(host.tools.execute).toHaveBeenCalledWith({ operationId: 'pi-tool:task-17:call-42', runOperationId: 'user-operation', action, signal: context.abortSignal });
  });
  it('preserves the operation id across replay of a safe tool', async () => {
    const host = bridge();
    await executeComputerTool(host, { type: 'readFile', path: '/workspace/a' }, api, context);
    await executeComputerTool(host, { type: 'readFile', path: '/workspace/a' }, api, context);
    const calls = vi.mocked(host.tools.execute).mock.calls;
    expect(calls[0]?.[0].operationId).toBe(calls[1]?.[0].operationId);
  });
  it('refuses dispatch after the durable tool budget is exhausted', async () => {
    const host = bridge();
    host.consume = () => { throw new Error('budget exceeded'); };
    const result = await executeComputerTool(host, { type: 'screenshot' }, api, context);
    expect(host.tools.execute).not.toHaveBeenCalled();
    expect(result.control).toEqual({ terminate: true });
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
    for (const name of ['exec', 'write_file', 'browser_navigate', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll']) {
      expect(tools.find(tool => tool.name === name)?.replay).toBe('unsafe');
    }
    expect(tools.find(tool => tool.name === 'read_file')?.replay).toBe('safe');
  });
});

describe('public transcript projection', () => {
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
