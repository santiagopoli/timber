import {isModelErrorCode,MODEL_FAILURES,type BotEvent,type Run} from '../../../packages/contracts/src/index';

export type FailureAction = 'model'|'connection'|'context'|'continue'|'retry'|'none';
export function failureRecovery(run:Run,events:readonly BotEvent[]) {
  const event=[...events].reverse().find(item=>item.runId===run.id&&item.type==='run.failed');
  const recorded=run.errorCode??event?.data.errorCode;
  // Only exact historical public messages identify the old generic fallback.
  const legacyGeneric=['The model request failed before an answer completed.','The model could not complete this request.'].includes(run.error||'');
  const code=isModelErrorCode(recorded)?recorded:legacyGeneric?'model_request_failed':undefined;
  let action:FailureAction='continue';
  if(code){
    if(['model_unavailable','model_reasoning_unsupported','model_fast_unsupported','model_access_denied'].includes(code))action='model';
    else if(code==='chatgpt_not_connected')action='connection';
    else if(['model_context_length_exceeded','model_history_invalid'].includes(code))action='context';
    else if(['model_request_invalid','model_response_filtered','model_billing_required','chatgpt_allowance_exhausted'].includes(code))action='none';
    else if(code==='model_request_failed')action='retry';
  }
  return {code,message:code?MODEL_FAILURES[code]:run.error,action};
}
