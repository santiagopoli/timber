import type { ComputerAction } from '@botspace/contracts';

type DisplayInput = Record<string, string | number | boolean>;
const bounded = (value: string, limit = 2_000) => {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};

/** URLs are navigation metadata. Credentials, queries and fragments are not. */
function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[URL omitted]';
    return bounded(`${url.origin}${url.pathname}${url.search ? '?…' : ''}${url.hash ? '#…' : ''}`);
  } catch { return '[URL omitted]'; }
}

function displayCommand(value: string): string {
  // Keep the actual command and flags useful without copying common credential
  // forms or heredoc file bodies into the activity projection. Execution still
  // receives the original validated action, never this presentation string.
  return bounded(value
    .replace(/(<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n)[\s\S]*/g, '$1[heredoc omitted]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, displayUrl)
    .replace(/\b((?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:)\s*[^\n'";]+/gi, '$1 [redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s'";]+/gi, match => `${match.split(/\s/, 1)[0]} [redacted]`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)|TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=[redacted]')
    .replace(/(--?(?:token|password|secret|api[-_]key|access[-_]key|client[-_]secret|authorization|cookie|user)|-u)(?:(\s*=\s*)|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|cfk_[A-Za-z0-9_]+)\b/g, '[redacted]'));
}

/** A small, explicit display contract; do not spread raw tool arguments here. */
export function computerActivityInput(action: ComputerAction): DisplayInput {
  switch (action.type) {
    case 'exec': return {command: displayCommand(action.command), ...(action.timeoutMs === undefined ? {} : {timeoutMs: action.timeoutMs}), yieldMs: action.yieldMs ?? 1_000};
    case 'execPoll': return {processId: action.processId, yieldMs: action.yieldMs ?? 1_000};
    case 'execCancel': return {processId: action.processId};
    case 'readFile':
    case 'writeFile': return {path: bounded(action.path)};
    case 'listFiles': return {path: bounded(action.path ?? '/workspace')};
    case 'move': return {x: action.x, y: action.y};
    case 'click':
    case 'doubleClick': return {x: action.x, y: action.y, button: action.button ?? 'left'};
    case 'drag': return {fromX: action.fromX, fromY: action.fromY, toX: action.toX, toY: action.toY, button: action.button ?? 'left', durationMs: action.durationMs ?? 500};
    case 'type': return {characters: Array.from(action.text).length};
    case 'key': return {key: bounded(action.key, 100)};
    case 'scroll': return {direction: action.direction, amount: action.amount ?? 3};
    case 'navigate': return {url: displayUrl(action.url)};
    case 'gitClone':
    case 'gitPush': return {repository: bounded(action.repository), path: bounded(action.path), ...(action.branch ? {branch: bounded(action.branch)} : {})};
    case 'screenshot':
    case 'checkpoint': return {};
  }
}

const hostFields: Record<string, readonly string[]> = {
  load_skill: ['name'],
  github_connect: ['repository', 'permission'],
  github_list_repositories: ['page'],
  github_clone: ['repository', 'path', 'branch'],
  github_push: ['repository', 'path', 'branch'],
  github_create_pull_request: ['repository', 'head', 'base', 'draft'],
  github_list_pull_requests: ['repository', 'head'],
  publish_app: ['name', 'port'],
  list_apps: [],
  remove_app: ['appId'],
  list_bots: [],
  create_bot: ['name'],
  send_to_bot: ['botId'],
};

export function hostActivityInput(name: string, args: Record<string, unknown>): DisplayInput {
  const input: DisplayInput = {};
  for (const key of hostFields[name] ?? []) {
    const value = args[key];
    if (typeof value === 'string') input[key] = bounded(value);
    else if (typeof value === 'number' || typeof value === 'boolean') input[key] = value;
  }
  return input;
}
