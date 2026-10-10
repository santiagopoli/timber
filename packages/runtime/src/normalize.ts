import type { EntryRecord } from '@earendil-works/pi-durable';
import type { RuntimeMessage } from './types.js';
import {MODEL_FAILURES, classifyModelFailure, modelFailure, type ModelErrorCode} from '@botspace/contracts';
import { CONTINUATION_PREFIX } from './stop-gate.js';

/** Do not expose provider-specific payloads or private reasoning in the app. */
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part): part is { type: 'text'; text: string } =>
    !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
  ).map(part => part.text).join('');
}
export function normalizeEntries(entries: readonly EntryRecord[]): RuntimeMessage[] {
  return entries.filter(entry => entry.kind !== 'pi.compaction').flatMap(entry => (entry.model ?? []).flatMap((message, index) => {
    const role = message.role === 'toolResult' ? 'tool' : message.role;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) return [];
    if (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)) return [];
    const text = textContent(message.content);
    if (!text) return [];
    if (role === 'user' && text.startsWith(CONTINUATION_PREFIX)) return [];
    const timestamp = 'timestamp' in message ? message.timestamp : undefined;
    const kind = message.role === 'assistant'
      ? message.content.some(part => part.type === 'toolCall') ? 'progress'
      : ['stop', 'length'].includes(message.stopReason) ? 'final' : undefined
      : undefined;
    return [{
      id: `pi:${String(entry.id)}:${index}`,
      role: role as RuntimeMessage['role'],
      text,
      ...(kind ? { kind: kind as RuntimeMessage['kind'] } : {}),
      ...(typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? { createdAt: new Date(timestamp).toISOString() } : {}),
    }];
  }));
}

/** Correlate a native completion with the host journal without exposing tool output. */
export function toolCompletion(entry: EntryRecord | undefined): { operationId?: string; processId?: string; status?: string } {
  const message = entry?.model?.find(message => message.role === 'toolResult');
  if (!message || message.role !== 'toolResult') return {};
  try {
    const result = JSON.parse(textContent(message.content)) as { operationId?: unknown; processId?: unknown; status?: unknown };
    return {
      ...(typeof result.operationId === 'string' && /^[A-Za-z0-9:_.-]{1,160}$/.test(result.operationId) ? { operationId: result.operationId } : {}),
      ...(typeof result.processId === 'string' && /^[A-Za-z0-9:_.-]{1,160}$/.test(result.processId) ? { processId: result.processId } : {}),
      ...(typeof result.status === 'string' && ['running', 'completed', 'cancelled', 'failed', 'interrupted', 'pending_approval', 'pending_connection'].includes(result.status) ? { status: result.status } : message.isError ? { status: 'failed' } : {}),
    };
  } catch { return message.isError ? { status: 'failed' } : {}; }
}

/** Publish an actionable failure category without copying provider bodies or prompts. */
export function classifyFailure(reason: string, detail: unknown): { errorCode: string; publicMessage: string } {
  const text = typeof detail === 'string' ? detail : '';
  // New transport errors carry a fixed code. Classify it before looking at
  // prose, which may itself mention billing, limits or context as reassurance.
  for(const code of Object.keys(MODEL_FAILURES) as ModelErrorCode[]) {
    if(new RegExp(`\\b${code}\\b`).test(text))return modelFailure(code);
  }
  // Older SDK error events can retain only the provider's prose, without its
  // error code. Reclassify those persisted subscription failures as well.
  const allowance=classifyModelFailure({message:text});
  if(allowance.errorCode==='chatgpt_allowance_exhausted')return allowance;
  if(/chatgpt_invalid_tool_namespace|invalid_encrypted_content/.test(text))return modelFailure('model_history_invalid');
  if(/chatgpt_invalid_protocol|chatgpt_unsupported_tool|chatgpt_invalid_request|chatgpt_invalid_endpoint/.test(text))return modelFailure('model_request_invalid');
  const providerCode=text.match(/\b(?:subscription_sharing_[a-z_]+|chatpass_v2_[a-z_]+|context_length_exceeded|invalid_request_error|invalid_value|unsupported_parameter|model_not_found|rate_limit_exceeded|server_error|internal_error|service_unavailable)\b/)?.[0];
  if(providerCode)return classifyModelFailure({code:providerCode,message:text});
  if (/model_empty_response/.test(text)) {
    return { errorCode: 'model_empty_response', publicMessage: 'The model returned no answer after automatic retries. Your recorded tool results are preserved.' };
  }
  if (/Run (?:generation|tool) budget exhausted/.test(text)) return { errorCode: 'runtime_budget_exceeded', publicMessage: 'This task reached its execution limit. Continue from the recorded results.' };
  if (/chatgpt_response_filtered/.test(text)) return { errorCode: 'model_response_filtered', publicMessage: 'The model provider could not return a response to this request.' };
  if (/chatgpt_not_connected|chatgpt_reauthorization_required|chatgpt_reauthentication_required|chatgpt_connection_expired|subscription_sharing_invalid_user/.test(text)) {
    return { errorCode: 'chatgpt_not_connected', publicMessage: 'Connect ChatGPT before running this bot.' };
  }
  if (/subscription_sharing_usage_limit_exceeded|chatgpt_allowance_exhausted/.test(text)) {
    return { errorCode: 'chatgpt_allowance_exhausted', publicMessage: 'Your ChatGPT usage allowance is exhausted. Check your ChatGPT usage before retrying.' };
  }
  if (/subscription_sharing_usage_unavailable/.test(text)) {
    return { errorCode: 'chatgpt_usage_unavailable', publicMessage: 'ChatGPT plan usage is temporarily unavailable. Retry later.' };
  }
  if (/chatgpt_output_limit/.test(text)) {
    return { errorCode: 'model_output_limit', publicMessage: 'The model response exceeded this bot’s output limit.' };
  }
  if (/paid(?:\s+access|\s+plan|\s+account)|(?:billing|payment).*(?:required|exhausted|disabled|not enabled)|insufficient\s+(?:balance|credits)|free\s+(?:tier|plan)/i.test(text)) {
    return { errorCode: 'model_billing_required', publicMessage: 'The selected model requires paid Workers AI access or available billing credits.' };
  }
  if (reason === 'no_model' || /(?:model.*(?:not found|does not exist|unavailable)|unknown model)/i.test(text)) {
    return { errorCode: 'model_unavailable', publicMessage: 'The selected model is not available to this runtime or account.' };
  }
  if (/rate.?limit|too many requests|quota/i.test(text)) {
    return { errorCode: 'model_rate_limited', publicMessage: 'The model provider refused the request because a rate or usage limit was reached.' };
  }
  if (/unauthorized|authentication|forbidden|permission|access.denied/i.test(text)) {
    return { errorCode: 'model_access_denied', publicMessage: 'The model provider denied access to the selected model.' };
  }
  if (/timeout|timed out|deadline/i.test(text)) {
    return { errorCode: 'model_timeout', publicMessage: 'The model request exceeded its time limit.' };
  }
  if (reason !== 'aborted' && /chatgpt_incomplete_response|ended without|stream ended before|connection.?lost|socket hang up|fetch failed|terminated/i.test(text)) return { errorCode: 'model_connection_interrupted', publicMessage: 'The model connection was interrupted and could not recover. Your recorded tool results are preserved.' };
  return reason === 'aborted' ? {errorCode:'run_aborted',publicMessage:'The run was stopped before an answer completed.'} : modelFailure('model_request_failed');
}
