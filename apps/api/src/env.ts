export interface Env {
  WORKSPACE: DurableObjectNamespace;
  BOT: DurableObjectNamespace;
  COMPUTER: DurableObjectNamespace;
  GITHUB?: DurableObjectNamespace;
  GITHUB_PUBLIC_ORIGIN?: string;
  PREVIEW_ORIGIN?: string;
  CHATGPT?: DurableObjectNamespace;
  CHATGPT_CREDENTIAL_KEY?: string;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS?: Fetcher;
  BOTSPACE_API_TOKEN?: string;
  BOTSPACE_DEFAULT_MODEL?: string;
}
