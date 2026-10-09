import type {Run} from '../../../packages/contracts/src/index';

export function canRetryAdmission(run: Pick<Run,'status'|'error'|'admissionRetryable'>): boolean {
  if (run.admissionRetryable !== undefined) return run.admissionRetryable && ['queued','failed'].includes(run.status);
  // Historical transport receipts used this hint before the explicit flag.
  return run.status === 'queued' && Boolean(run.error?.includes('Retry this message'));
}
