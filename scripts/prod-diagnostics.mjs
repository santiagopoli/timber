#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Cloudflare's public telemetry query API; raw events stay in process memory.
// https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
export const SCRIPT = 'timber-api';
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ENTRYPOINTS = new Set(['ComputerDO', 'BotDO', 'WorkspaceDO', 'ChatGPTAuthDO', 'GitHubAuthDO', 'WorkspacePreviewGateway', 'default']);
const OUTCOMES = new Set(['ok', 'exception', 'canceled', 'cancelled', 'exceededCpu', 'exceededMemory', 'responseStreamDisconnected', 'scriptNotFound', 'unknown']);
const EVENT_TYPES = new Set(['fetch', 'scheduled', 'alarm', 'cron', 'queue', 'email', 'tail', 'rpc', 'jsrpc', 'websocket', 'workflow', 'unknown']);
const LEVELS = new Set(['debug', 'info', 'log', 'warn', 'error']);
const STAGES = new Set(['request', 'checkpoint', 'post_result_touch', 'exec_admission', 'checkpoint_retry', 'git_capability_revoke', 'preview_touch', 'start', 'restore', 'execute']);
const CHECKPOINT_PHASES = new Set(['archive_upload', 'pointer_publish', 'retry_intent', 'candidate_lookup']);
const CHECKPOINT_CAUSES = new Set(['metadata_write', 'stream_length', 'checksum', 'rate_limit', 'transport', 'unknown']);
export const DIAGNOSTIC_CODES = new Set([
  'computer_unavailable', 'computer_not_configured', 'computer_image_missing', 'computer_start_failed',
  'computer_lifecycle_failed', 'computer_provisioning_failed', 'computer_start_timeout',
  'computer_server_install_failed', 'computer_server_start_failed', 'computer_not_ready',
  'computer_restore_missing', 'computer_restore_failed', 'computer_checkpoint_failed',
  'computer_checkpoint_changed', 'computer_checkpoint_limit', 'computer_checkpoint_nonportable',
  'computer_checkpoint_integrity_failed', 'computer_checkpoint_persist_failed', 'computer_checkpoint_lost',
  'computer_invalid_request', 'computer_method_not_allowed', 'computer_owner_mismatch', 'computer_deleted',
  'computer_upgrade_required', 'computer_git_unavailable', 'computer_busy', 'computer_process_limit',
  'computer_checkpoint_pending', 'computer_app_not_running', 'chatgpt_transport_error', 'chatgpt_output_limit',
  'chatgpt_incomplete_response', 'chatgpt_allowance_exhausted', 'chatgpt_reauthorization_required',
  'chatgpt_refresh_pending', 'chatgpt_refresh_failed', 'chatgpt_not_connected',
  'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported',
]);
const KNOWN_LOGS = new Set(['computer.failure', 'computer.checkpoint_failure', 'approval.failure']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const increment = (table, value) => { table[value] = (table[value] ?? 0) + 1; };
const finite = (value, maximum = 1e12) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;

export function timeframe(input = {}, now = Date.now()) {
  const hours = Number(input.hours ?? 6);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error('diagnostics_hours_must_be_1_to_24');
  const end = input.end;
  if (end && (typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(end))) throw new Error('diagnostics_end_must_be_utc_iso');
  const to = end ? Date.parse(end) : now;
  if (!Number.isFinite(to) || to > now + 60_000 || to < now - 7 * 24 * 3600_000) throw new Error('diagnostics_end_outside_last_7_days');
  return { from: to - hours * 3600_000, to };
}

export function queryBody(window, offset) {
  return {
    queryId: `timber-diagnostics-${randomUUID()}`, timeframe: window,
    view: 'events', limit: PAGE_SIZE, dry: true, chart: false, ignoreSeries: true,
    parameters: {
      datasets: ['cloudflare-workers'], filterCombination: 'and',
      filters: [{key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT}],
    },
    ...(offset ? {offset, offsetDirection: 'next'} : {}),
  };
}

function labels(value, output, depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 30)) labels(item, output, depth + 1); return; }
  if (typeof value === 'string') {
    // Fixed labels only: never return a raw message, exception, command or URL.
    for (const word of value.slice(0, 32_000).match(/[a-z][a-z0-9_.]+/g) ?? []) {
      if (DIAGNOSTIC_CODES.has(word)) output.codes.add(word);
      if (KNOWN_LOGS.has(word)) output.logs.add(word);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (key === 'stage' && (STAGES.has(item) || DIAGNOSTIC_CODES.has(item))) output.stages.add(item);
    if (key === 'phase' && CHECKPOINT_PHASES.has(item)) output.phases.add(item);
    if (key === 'cause' && CHECKPOINT_CAUSES.has(item)) output.causes.add(item);
    // Credentials and request payloads are neither interpreted nor traversed.
    if (['message', 'error', 'code', 'errorCode', 'logs', 'exceptions', 'arguments', 'stage', 'phase', 'cause'].includes(key)) labels(item, output, depth + 1);
  }
}

export function summarize(events, window, {pages = 1, truncated = false} = {}) {
  const summary = {
    worker: SCRIPT, window: {from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString()},
    pages, sampledEvents: 0, ignoredEvents: 0, truncated,
    limitation: 'Sampled Cloudflare telemetry only. Missing events do not prove absence of failures. This report contains no bot transcript or command output.',
    counts: {entrypoints: {}, outcomes: {}, eventTypes: {}, levels: {}, httpStatuses: {}, diagnosticCodes: {}, logTypes: {}, stages: {}, checkpointPhases: {}, checkpointCauses: {}},
    deploymentIds: [], durationMs: {observed: 0, total: 0, max: 0},
  };
  const versions = new Set();
  for (const event of events) {
    const metadata = object(event.$metadata), worker = object(event.$workers);
    if ((metadata.service !== SCRIPT && worker.scriptName !== SCRIPT) || (metadata.service && metadata.service !== SCRIPT) || (worker.scriptName && worker.scriptName !== SCRIPT)
      || !finite(event.timestamp, 8.64e15) || event.timestamp < window.from || event.timestamp > window.to) { summary.ignoredEvents++; continue; }
    summary.sampledEvents++;
    for (const [field, value, allow] of [['entrypoints', worker.entrypoint, ENTRYPOINTS], ['outcomes', worker.outcome, OUTCOMES], ['eventTypes', worker.eventType, EVENT_TYPES], ['levels', metadata.level, LEVELS]]) {
      increment(summary.counts[field], allow.has(value) ? value : 'unspecified');
    }
    const status = metadata.statusCode ?? object(object(worker.event).response).status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) increment(summary.counts.httpStatuses, String(status));
    const duration = metadata.duration ?? worker.wallTimeMs;
    if (finite(duration)) {summary.durationMs.observed++; summary.durationMs.total += duration; summary.durationMs.max = Math.max(summary.durationMs.max, duration);}
    const version = object(worker.scriptVersion).id;
    if (typeof version === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(version)) versions.add(version);
    const found = {codes: new Set(), logs: new Set(), stages: new Set(), phases: new Set(), causes: new Set()};
    labels(event.source, found); labels(metadata.message, found); labels(metadata.error, found);
    for (const [field, values] of [['diagnosticCodes', found.codes], ['logTypes', found.logs], ['stages', found.stages], ['checkpointPhases', found.phases], ['checkpointCauses', found.causes]]) for (const value of values) increment(summary.counts[field], value);
  }
  summary.deploymentIds = [...versions].sort();
  return summary;
}

async function readJson(response) {
  if (!response.body) throw new Error('diagnostics_empty_response');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let length = 0, text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('diagnostics_response_too_large');
      text += decoder.decode(part.value, {stream: true});
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new Error('diagnostics_invalid_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function collect({env = process.env, fetcher = fetch, now = Date.now()} = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof account !== 'string' || !/^[a-f0-9]{24,64}$/i.test(account)) throw new Error('diagnostics_account_not_configured');
  const headers = {'content-type': 'application/json'};
  if (env.CLOUDFLARE_API_TOKEN) headers.Authorization = `Bearer ${env.CLOUDFLARE_API_TOKEN}`;
  else if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL) {headers['X-Auth-Key'] = env.CLOUDFLARE_API_KEY; headers['X-Auth-Email'] = env.CLOUDFLARE_EMAIL;}
  else throw new Error('diagnostics_cloudflare_auth_not_configured');
  const window = timeframe({hours: env.DIAGNOSTIC_HOURS, end: env.DIAGNOSTIC_END}, now);
  const records = [], ids = new Set(); let offset, truncated = false, pages = 0;
  for (; pages < MAX_PAGES;) {
    let response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
        method: 'POST', headers, body: JSON.stringify(queryBody(window, offset)), redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new Error('diagnostics_cloudflare_transport_failed'); }
    if (!response.ok) {await response.body?.cancel().catch(() => {}); throw new Error(`diagnostics_cloudflare_http_${response.status}`);}
    const payload = await readJson(response);
    if (payload.success === false) throw new Error('diagnostics_cloudflare_query_rejected');
    const events = payload.result?.events?.events;
    if (!Array.isArray(events)) throw new Error('diagnostics_unrecognized_event_response');
    pages++;
    for (const event of events) {
      const id = object(event?.$metadata).id;
      if (typeof id === 'string' && ids.has(id)) continue;
      if (typeof id === 'string') ids.add(id);
      records.push(object(event));
    }
    if (events.length < PAGE_SIZE) break;
    const next = object(events.at(-1)?.$metadata).id;
    if (typeof next !== 'string' || !next || next.length > 512 || next === offset) {truncated = true; break;}
    offset = next;
    truncated = pages === MAX_PAGES;
  }
  return summarize(records, window, {pages, truncated});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await collect(), null, 2)); }
  catch (error) {
    // Never log exception messages supplied by a network response or transport.
    const code = /^diagnostics_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'diagnostics_failed';
    console.error(JSON.stringify({error: code})); process.exitCode = 1;
  }
}
