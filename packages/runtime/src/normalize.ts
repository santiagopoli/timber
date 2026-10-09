import type { EntryRecord } from '@earendil-works/pi-durable';
import type { RuntimeMessage } from './types.js';

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
  if (/paid(?:\s+access|\s+plan|\s+account)|billing|payment|insufficient\s+(?:balance|credits)|free\s+(?:tier|plan)/i.test(text)) {
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
  return { errorCode: reason === 'aborted' ? 'run_aborted' : 'model_request_failed', publicMessage: reason === 'aborted' ? 'The run was stopped before an answer completed.' : 'The model request failed before an answer completed.' };
}
