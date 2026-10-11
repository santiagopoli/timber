import {ApiError} from './errors';
import {AudioValidationError, validateAudio as validateAudioBytes, type ValidatedAudio} from '../../../packages/contracts/src/audio-validation';

export {MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS} from '../../../packages/contracts/src/audio-validation';
export type {ValidatedAudio} from '../../../packages/contracts/src/audio-validation';

/** Keep the API error envelope while sharing identical byte preflight with UI. */
export function validateAudio(bytes: Uint8Array, contentType: string): ValidatedAudio {
  try {return validateAudioBytes(bytes, contentType);}
  catch (error) {
    if (error instanceof AudioValidationError) throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}
