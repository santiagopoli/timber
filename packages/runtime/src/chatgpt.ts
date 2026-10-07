import type { Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createProvider } from '@earendil-works/pi-ai/models';
import type { PiRuntimeOptions } from './types.js';

export const CHATGPT_MODEL = 'gpt-6.1-sol';
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const TOOL_NAMESPACE = 'timber_computer';
export const MAX_OUTPUT_CHARACTERS = 65_536;

export const chatgptModel: Model<'openai-responses'> = {
  id: CHATGPT_MODEL, name: 'GPT-6.1 Sol (ChatGPT)', api: 'openai-responses',
  provider: 'openai', baseUrl: 'https://api.openai.com/v1',
  input: ['text', 'image'], reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: null, max: null },
  // Subscription allowance is not API-token billing; do not invent a dollar cost.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: true, supportsAdditionalTools: false, supportsMaxOutputTokens: false, supportsLongCacheRetention: false },
};

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chatgpt_invalid_protocol');
  return value as JsonObject;
}

/** Rebuild the allowed request shape; future SDK defaults cannot add paid-API-only fields. */
export function chatgptPayload(value: unknown): JsonObject {
  const payload = object(value);
  if (!Array.isArray(payload.input)) throw new Error('chatgpt_invalid_protocol');
  const input = payload.input.map(value => {
    const item = object(value);
    if (item.type === 'function_call' && item.namespace !== TOOL_NAMESPACE) throw new Error('chatgpt_invalid_tool_namespace');
    return item.role === 'system' ? { ...item, role: 'developer' } : item;
  });
  const functions = Array.isArray(payload.tools) ? payload.tools.map(value => {
    const tool = object(value);
    if (tool.type !== 'function') throw new Error('chatgpt_unsupported_tool');
    return tool;
  }) : [];
  return {
    model: CHATGPT_MODEL, input, store: false, stream: true,
    reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'],
    ...(functions.length ? { tools: [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools for this bot’s reusable computer, connected services, skills and apps, subject to host policy.', tools: functions }] } : {}),
  };
}

/** The SDK needs a nonempty credential locally. This public sentinel never leaves this adapter. */
const SDK_SENTINEL = 'timber-host-owned-oauth-transport';

export function createChatGPTProvider(transport: PiRuntimeOptions<object>['chatgpt']) {
  const run = (model: Model<'openai-responses'>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let outputCharacters = 0;
    return streamSimple(model, context, {
      // Deliberately do not forward apiKey, base URL, headers, env, fetch or payload hooks.
      apiKey: SDK_SENTINEL, signal, timeoutMs: Math.min(options?.timeoutMs ?? 120_000, 120_000),
      maxRetries: 0, cacheRetention: 'none', env: {}, reasoning: 'low',
      onPayload: chatgptPayload,
      fetch: async (input, init) => {
        const incoming = new Request(input, init);
        if (incoming.url !== RESPONSES_URL || incoming.method !== 'POST') throw new Error('chatgpt_invalid_endpoint');
        if (!transport) return Response.json({ error: { code: 'chatgpt_not_connected', message: 'Connect ChatGPT before running this bot.' } }, { status: 401 });
        // A fresh header allowlist removes the SDK sentinel, ambient auth and SDK telemetry.
        const request = new Request(RESPONSES_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: await incoming.text(), signal: incoming.signal, redirect: 'manual',
        });
        return transport.fetch(request);
      },
      onProviderStreamEvent(value) {
        const event = object(value);
        if (event.type === 'response.incomplete') throw new Error('chatgpt_incomplete_response');
        const item = event.item ? object(event.item) : undefined;
        if (item?.type === 'function_call' && item.namespace !== TOOL_NAMESPACE) throw new Error('chatgpt_invalid_tool_namespace');
        if (item?.type === 'custom_tool_call') throw new Error('chatgpt_unsupported_tool');
        // This endpoint forbids max_output_tokens. Bound generated content locally and abort
        // before Pi can accept unfinished calls. The harness separately enforces a timeout.
        if (typeof event.delta === 'string') outputCharacters += event.delta.length;
        const finalSize = item && event.type === 'response.output_item.done' ? JSON.stringify(item).length : 0;
        if (outputCharacters > MAX_OUTPUT_CHARACTERS || finalSize > MAX_OUTPUT_CHARACTERS) {
          controller.abort();
          throw new Error('chatgpt_output_limit');
        }
      },
    });
  };
  return createProvider<'openai-responses'>({
    id: 'openai', name: 'Sign in with ChatGPT', baseUrl: chatgptModel.baseUrl,
    // Ambient host capability, never an environment API key or Pi credential store.
    auth: { apiKey: { name: 'Host-owned ChatGPT connection', resolve: async () => ({ auth: {}, source: 'ChatGPT transport' }) } },
    models: [chatgptModel], api: {
      stream: (model, context, options) => run(model as Model<'openai-responses'>, context, options),
      streamSimple: (model, context, options) => run(model as Model<'openai-responses'>, context, options),
    },
  });
}
