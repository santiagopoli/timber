export interface Env {
  WORKSPACE: DurableObjectNamespace;
  BOT: DurableObjectNamespace;
  COMPUTER: DurableObjectNamespace;
  GITHUB?: DurableObjectNamespace;
  GITHUB_PUBLIC_ORIGIN?: string;
  PREVIEW_ORIGIN?: string;
  CHATGPT?: DurableObjectNamespace;
  CHATGPT_CREDENTIAL_KEY?: string;
  /** Server-only Worker secret. Enables paid OpenAI model inference, Image API and audio transcription. */
  OPENAI_API_KEY?: string;
  /** Server-only inference credential. Enables the OpenRouter catalog and paid quota fallback. */
  OPENROUTER_API_KEY?: string;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS?: Fetcher;
  BOTSPACE_API_TOKEN?: string;
  BOTSPACE_DEFAULT_MODEL?: string;
  /** Optional per-task budgets. Unset or 0 leaves the task count uncapped. */
  BOTSPACE_MAX_GENERATIONS?: string;
  BOTSPACE_MAX_TOOL_CALLS?: string;
}
