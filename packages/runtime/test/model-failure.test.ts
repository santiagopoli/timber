import {describe,expect,it} from 'vitest';
import {classifyModelFailure,modelFailure,type ModelErrorCode} from '@botspace/contracts';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {isContextOverflow} from '@earendil-works/pi-ai/utils/overflow';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import {classifyFailure} from '../src/normalize.js';

describe('safe model failure categories preserve native recovery',()=>{
  it.each([
    [{status:400,code:'invalid_value',param:'service_tier'},'model_fast_unsupported'],
    [{status:400,code:'unsupported_value',param:'reasoning.effort'},'model_reasoning_unsupported'],
    [{status:400,code:'context_length_exceeded'},'model_context_length_exceeded'],
    [{status:400,code:'invalid_encrypted_content'},'model_history_invalid'],
    [{status:400,code:'model_not_found'},'model_unavailable'],
    [{status:403,code:'subscription_sharing_unsupported_capability'},'model_access_denied'],
    [{status:401},'chatgpt_not_connected'],
    [{status:429,code:'subscription_sharing_usage_limit_exceeded'},'chatgpt_allowance_exhausted'],
    [{status:429,code:'rate_limit_exceeded'},'model_rate_limited'],
    [{status:503,code:'unrecognized_provider_code'},'model_provider_unavailable'],
    [{status:400,code:'unrecognized_provider_code'},'model_request_invalid'],
  ])('classifies %j without copying provider material',(input,code)=>{
    const failure=classifyModelFailure({...input,message:'PRIVATE_PROVIDER_BODY_TOKEN_USER_CONTENT'});
    expect(failure.errorCode).toBe(code);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_PROVIDER');
    expect(classifyFailure('model_error',`OpenAI API error: ${failure.errorCode}: ${failure.publicMessage}`)).toEqual(failure);
  });
  it.each(['model_provider_unavailable','model_rate_limited','model_timeout','model_connection_interrupted','chatgpt_usage_unavailable'] as ModelErrorCode[])('retains bounded native retry for %s',code=>{
    const failure=modelFailure(code);
    expect(isRetryableAssistantError({stopReason:'error',errorMessage:`${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage)).toBe(true);
  });
  it.each(['model_request_invalid','model_history_invalid','model_fast_unsupported','model_reasoning_unsupported','model_access_denied','chatgpt_allowance_exhausted'] as ModelErrorCode[])('does not automatically retry permanent %s',code=>{
    const failure=modelFailure(code);
    expect(isRetryableAssistantError({stopReason:'error',errorMessage:`${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage)).toBe(false);
  });
  it('keeps context overflow recognizable to native automatic compaction',()=>{
    const failure=modelFailure('model_context_length_exceeded');
    expect(isContextOverflow({stopReason:'error',errorMessage:`${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage)).toBe(true);
  });
  it('does not infer billing from the old transport reassurance',()=>{
    expect(classifyFailure('model_error','The ChatGPT request could not be completed. No alternative billing provider was used.').errorCode).toBe('model_request_failed');
    expect(classifyFailure('model_error','This model requires a Workers Paid plan.').errorCode).toBe('model_billing_required');
  });
  it('keeps HTTP allowance exhaustion terminal even when the SDK includes 429',()=>{
    const failure=classifyModelFailure({status:429,code:'subscription_sharing_usage_limit_exceeded'});
    const message={stopReason:'error',errorMessage:`429 ${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage;
    expect(isRetryableAssistantError(message)).toBe(false);
  });
  it('does not treat per-minute rate limits as context overflow',()=>{
    const failure=classifyModelFailure({status:429,code:'rate_limit_exceeded',message:'Too many input tokens per minute; rate limit reached.'});
    const message={stopReason:'error',errorMessage:`429 ${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage;
    expect(failure.errorCode).toBe('model_rate_limited');
    expect(isContextOverflow(message)).toBe(false);
    expect(isRetryableAssistantError(message)).toBe(true);
  });
  it.each([{code:'subscription_sharing_user_unavailable'},{code:'unknown',message:'You can retry your request'}])('preserves explicit transient SSE recovery %j',input=>{
    const failure=classifyModelFailure(input);
    expect(isRetryableAssistantError({stopReason:'error',errorMessage:`${failure.errorCode}: ${failure.publicMessage}`} as AssistantMessage)).toBe(true);
  });
  it('classifies local history protocol failures before any provider request',()=>{
    expect(classifyFailure('model_error','chatgpt_invalid_tool_namespace')).toEqual(modelFailure('model_history_invalid'));
  });
});
