/** Immutable, private original audio metadata. See docs/audio-messages.md. */
export interface AudioAttachment {
  artifactId: string;
  mimeType: "audio/wav" | "audio/webm" | "audio/mpeg";
  size: number;
  durationMs: number;
}
/** A dispatched attempt may be uncertain; only an explicit owner retry can charge again. */
export interface AudioTranscription {
  attemptId: string;
  status: "pending" | "dispatching" | "succeeded" | "failed" | "uncertain";
  text?: string;
  errorCode?: string;
  error?: string;
}
export interface MessageAudio extends AudioAttachment {
  operationId: string;
  transcription: AudioTranscription;
}
