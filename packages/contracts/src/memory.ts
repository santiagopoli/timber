/** Timber memory is durable application data, independent of model context. */
export type MemoryCategory = 'preference' | 'fact' | 'decision' | 'procedure';
export type MemoryActor = 'user' | 'agent' | 'review';
export type MemoryState = 'active' | 'suggested' | 'forgotten';
export interface MemorySource {
  kind: 'user' | 'conversation';
  messageId?: string;
  role?: 'user' | 'assistant';
  quote?: string;
  createdAt?: string;
}
export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  state: MemoryState;
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  actor: MemoryActor;
  sources: MemorySource[];
  /** An automatic correction is a suggestion until explicitly accepted. */
  replacesId?: string;
  /** Revision reviewed when the suggestion was created, never silently rebased. */
  replacesRevision?: number;
}
export interface MemorySaveInput {
  operationId: string;
  id?: string;
  expectedRevision?: number;
  category: MemoryCategory;
  title: string;
  content: string;
  pinned?: boolean;
}
export interface MemoryForgetInput {operationId: string; id: string; expectedRevision: number;}
export interface MemorySuggestionInput extends MemorySaveInput {replacesId?: string; replacesRevision?: number;}
export interface MemoryAcceptInput {operationId: string; id: string; expectedRevision: number; replacesRevision?: number;}
export interface MemoryMutationResult {entry: MemoryEntry; changed: boolean;}
export interface MemoryRevision {entry: MemoryEntry; operation: 'create' | 'update' | 'forget' | 'suggest' | 'accept'; at: string;}
export interface MemorySearchHit {entry: MemoryEntry; score: number;}
export interface MemorySearchResult {hits: MemorySearchHit[]; total: number; truncated: boolean;}
export interface MemoryReviewStatus {
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  operationId?: string;
  reason?: 'automatic' | 'manual' | 'compaction';
  updatedAt?: string;
  examinedMessages: number;
  added: number;
  suggested: number;
  error?: string;
  /** More source messages remain; a later batch continues from the checkpoint. */
  hasMore?: boolean;
}
export interface MemoryLegacy {content: string; revision: number; updatedAt?: string; importedAt: string;}
export interface MemoryLimits {maxEntries: number;maxEntryCharacters: number;maxTitleCharacters: number;contextCharacters: number;}
export interface BotMemory {
  schemaVersion: 2;
  entries: MemoryEntry[];
  suggestions: MemoryEntry[];
  legacy?: MemoryLegacy;
  revision: number;
  updatedAt?: string;
  limits: MemoryLimits;
  review: MemoryReviewStatus;
  /** Read-only human-readable export for older clients. Whole-document writes are retired. */
  content: string;
  maxCharacters: number;
}
