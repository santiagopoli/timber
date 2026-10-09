/** Fixed public diagnostics shared by the OAuth proxy, runtime and console.
 * Provider text is inspected only to classify a failure, never returned. */
export const MODEL_FAILURES = {
  chatgpt_not_connected: 'Reconnect ChatGPT in Settings before continuing this conversation.',
  chatgpt_allowance_exhausted: 'ChatGPT shared usage quota exceeded. Check ChatGPT Settings → Usage and wait for the limit to reset before trying again.',
  chatgpt_usage_unavailable: 'ChatGPT account or usage information is temporarily unavailable. Please retry your request later.',
  model_unavailable: 'The selected model is not available to this account. Choose another available model.',
  model_reasoning_unsupported: 'The provider rejected the selected reasoning level. Review the model settings before retrying.',
  model_fast_unsupported: 'The provider rejected Fast mode for this request. Turn off Fast or choose another supported model.',
  model_access_denied: 'The provider denied access to this model or capability. Review the account connection and model settings.',
  model_context_length_exceeded: 'This conversation exceeds the context window of the selected model. Compact the context or choose a model with a larger window.',
  model_request_invalid: 'The provider rejected the request format. Retrying the same request unchanged will not resolve it.',
  model_history_invalid: 'The model could not read part of the saved conversation context. The full conversation and recorded tool results are preserved.',
  model_rate_limited: 'The model provider reached a rate limit. Wait briefly before trying again.',
  model_timeout: 'The model request exceeded its time limit. Your conversation and recorded tool results are preserved.',
  model_connection_interrupted: 'Connection lost while receiving the model response. Your conversation and recorded tool results are preserved.',
  model_provider_unavailable: 'The model provider returned a server error. Try again later; your conversation and recorded tool results are preserved.',
  model_request_failed: 'The model request failed before an answer completed. Your conversation and recorded tool results are preserved.',
  model_output_limit: 'The model response exceeded this bot’s output limit. Your recorded tool results are preserved.',
  model_response_filtered: 'The model provider could not return a response to this request.',
  model_billing_required: 'The selected Workers AI model requires paid access or available billing credits.',
  model_empty_response: 'The model returned no answer after automatic retries. Your recorded tool results are preserved.',
} as const;
export type ModelErrorCode = keyof typeof MODEL_FAILURES;
export const isModelErrorCode = (value:unknown):value is ModelErrorCode => typeof value === 'string' && Object.hasOwn(MODEL_FAILURES,value);
export const modelFailure = (errorCode:ModelErrorCode) => ({errorCode,publicMessage:MODEL_FAILURES[errorCode]});

export function classifyModelFailure({status,code,param,message}:{status?:number;code?:unknown;param?:unknown;message?:unknown}) {
  if(isModelErrorCode(code))return modelFailure(code);
  const name=typeof code==='string'?code:'';
  const field=typeof param==='string'?param:'';
  const text=typeof message==='string'?message.slice(0,32_000):'';
  if(/chatgpt_(?:not_connected|reauthorization_required|reauthentication_required|connection_expired)|subscription_sharing_invalid_user/.test(name)||status===401)return modelFailure('chatgpt_not_connected');
  // Some subscription SSE errors carry only this prose: the SDK can discard
  // their code before the durable runtime sees them. Account allowance is
  // different from transient requests/tokens-per-minute rate limits.
  const sharedAllowance=/\b(?:chatgpt|subscription[\s_-]+sharing)\b/i.test(text)
    && !/\b(?:tokens?|requests?) per minute\b/i.test(text)
    && /\b(?:usage (?:quota|limit)[\s\S]{0,80}(?:reached|exceeded|exhausted)|(?:reached|exceeded|exhausted)[\s\S]{0,80}usage (?:quota|limit))\b/i.test(text);
  if(/subscription_sharing_usage_limit_exceeded|chatgpt_allowance_exhausted|insufficient_quota/.test(name)||sharedAllowance)return modelFailure('chatgpt_allowance_exhausted');
  if(/subscription_sharing_(?:usage|user)_unavailable|chatgpt_(?:usage_unavailable|refresh_pending|refresh_failed)/.test(name))return modelFailure('chatgpt_usage_unavailable');
  if(/rate_limit/.test(name))return modelFailure('model_rate_limited');
  if(/context_(?:length|window)_exceeded|too_many_tokens/.test(name))return modelFailure('model_context_length_exceeded');
  if(status===429||/rate[ _-]?limit|tokens per minute|requests per minute|too many requests/i.test(text))return modelFailure('model_rate_limited');
  if(/context (?:length|window)|maximum context|too many (?:input )?tokens(?!\s+per\b)/i.test(text))return modelFailure('model_context_length_exceeded');
  if(/invalid_encrypted_content|invalid_tool_namespace/.test(name)||/encrypted (?:content|reasoning)|(?:function|tool).*(?:call_id|namespace|matching|corresponding)|(?:call_id|namespace).*invalid/i.test(text))return modelFailure('model_history_invalid');
  if(/model_not_found|model_unavailable/.test(name)||field==='model')return modelFailure('model_unavailable');
  if(field==='service_tier'||/service_tier|(?:fast|priority) (?:mode|tier).*(?:unsupported|not supported|unavailable)/i.test(text))return modelFailure('model_fast_unsupported');
  if(field.startsWith('reasoning')||/reasoning[._ ](?:effort|summary).*(?:unsupported|not supported|invalid)/i.test(text))return modelFailure('model_reasoning_unsupported');
  if(/subscription_sharing_(?:user_not_eligible|unsupported_capability|route_not_supported)|chatpass_v2_|permission_denied|access_denied/.test(name)||status===403)return modelFailure('model_access_denied');
  if(/timeout|deadline/.test(name)||status===408||status===504)return modelFailure('model_timeout');
  if(/server_error|internal_error|service_unavailable/.test(name)||(status!==undefined&&status>=500))return modelFailure('model_provider_unavailable');
  if(/invalid_request|invalid_value|unsupported_(?:parameter|value)/.test(name)||status===400||status===422)return modelFailure('model_request_invalid');
  if(/you can retry your request|try your request again|please retry your request|currently experiencing high demand|model is at capacity/i.test(text))return modelFailure('model_provider_unavailable');
  return modelFailure('model_request_failed');
}
