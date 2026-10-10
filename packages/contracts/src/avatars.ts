import type { ModelOption } from './models';

/** Themes and their selection belong to the authenticated owner, never a bot. */
export interface AvatarTheme {
  id: string;
  name: string;
  kind: 'vector' | 'image';
  prompt: string;
  /** Structured design data. Older custom themes may only have a prompt. */
  style?: string;
  subject?: string;
  /** Transparent head artwork, displayed on a solid circle by the client. */
  framing?: 'circle';
  /** Stable built-in collection key; never accepted from theme creation input. */
  preset?: string;
  model: string;
  createdAt: string;
}
export interface AvatarSelection { themeId: string; revision: number; }
export interface BotAvatar {
  botId: string;
  themeId: string;
  revision: number;
  status: 'ready' | 'obsolete';
  artifactId: string;
  mimeType: 'image/svg+xml' | 'image/png' | 'image/jpeg';
  updatedAt: string;
}
export interface AvatarJob {
  id: string;
  operationId: string;
  botId: string;
  themeId: string;
  revision: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'obsolete';
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}
/** expectedThemeId/expectedRevision are owner-global preconditions, NOT overrides.
 * Both are required for images and checked for vectors whenever either is supplied.
 * Image requests also confirm the exact batch and separately billed API transport.
 * Receipt fingerprints bind all supplied fields; replay precedes current-selection
 * validation. Uncertain resends MUST preserve the original payload.
 */
export interface AvatarGenerationRequest {
  operationId: string;
  botId?: string;
  expectedThemeId?: string;
  expectedRevision?: number;
  confirmedCount?: number;
  acknowledgeApiBilling?: true;
}
export interface AvatarSettings {
  themes: AvatarTheme[];
  selection: AvatarSelection | null;
  avatars: BotAvatar[];
  /** Latest 100 jobs; generation receipts retain exact original job identities. */
  jobs: AvatarJob[];
}
/** API-key availability is configuration, not a verified account entitlement. */
export interface AvatarImageModel {
  id: 'gpt-image-2.5-sunburst' | 'gpt-image-2.5-flare';
  name: string;
  provider: 'openai';
  billing: 'openai-api';
}
export interface AvatarModelCatalog {
  /** SIWC connection state only; independent of API-key image availability. */
  connected: boolean;
  vectorModels: ModelOption[];
  imageModels: AvatarImageModel[];
  imageAvailable: boolean;
  imageBilling: {
    provider: 'openai-api';
    separateFromChatGPT: true;
    costKnown: false;
    message: string;
  };
  /** Documented image model IDs, NOT capability/availability claims for this account. */
  unavailableImageModels?: { id: string; name: string; available: false; reason: string }[];
  error?: string;
}
