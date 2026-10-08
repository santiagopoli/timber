import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon, ClockIcon, CopyIcon, LoaderCircleIcon, ShieldCheckIcon, ActivityIcon, WrenchIcon, GitBranchIcon, ExternalLinkIcon } from 'lucide-react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { defaultUrlTransform, type UrlTransform } from 'streamdown';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageActions, MessageAction, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { Confirmation, ConfirmationAction, ConfirmationActions } from '@/components/ai-elements/confirmation';
import { Button } from '@/components/ui/button';
import type { ChatApproval, ChatCallbacks, ChatModel, ChatConnection, MessageDelivery } from './chat-types';
import {ActivityCode, ActivityOutput, activityIdentity, outputFormat} from './activity-content';
import './chat.css';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const timestamp = (value?: string) => value ? Date.parse(value) || 0 : 0;
const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const label = (value: string) => value.replaceAll('_', ' ');
const safeJSON = (value: unknown): string => JSON.stringify(value, (key, item) => /token|secret|password|authorization|credential/i.test(key) ? '[hidden]' : item, 2);
const actionText = (approval: ChatApproval) => approval.action.type === 'type' ? 'Type text · input hidden' : approval.action.type === 'exec' ? approval.action.command : safeJSON(approval.action);
const responseComponents = { img: () => null };
// Keep Streamdown's URL sanitization, but use native links instead of its
// confirmation buttons so browser navigation and long-press actions work.
const responseLinkSafety = { enabled: false };
const responseUrlTransform: UrlTransform = (url, key, node) => url === 'streamdown:incomplete-link' ? undefined : defaultUrlTransform(url, key, node);

function Response({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MessageResponse className="timber-markdown" mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} parseIncompleteMarkdown skipHtml plugins={{}} components={responseComponents} linkSafety={responseLinkSafety} urlTransform={responseUrlTransform} controls={false}>{text}</MessageResponse>;
}

function CopyMessage({ text, kind = 'message', createdAt }: { text: string; kind?: 'message' | 'pending' | 'streaming'; createdAt?: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const busy = useRef(false), mounted = useRef(true), reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const name = kind === 'streaming' ? 'Copy response so far' : kind === 'pending' ? 'Copy pending message' : 'Copy message';
  useEffect(() => () => {mounted.current = false; clearTimeout(reset.current);}, []);
  const copy = async () => {
    if (busy.current || !text) return;
    busy.current = true; clearTimeout(reset.current); setState('copying');
    try {
      // Copy the original Markdown, including code fences and exact line breaks.
      await navigator.clipboard.writeText(text);
      if (mounted.current) {setState('copied'); reset.current = setTimeout(() => setState('idle'), 2500);}
    } catch {if (mounted.current) setState('failed');}
    finally {busy.current = false;}
  };
  return <MessageActions className="timber-message-actions">
    <MessageAction label={name} aria-label={name} title={name} data-copy-message disabled={state === 'copying' || !text} onClick={copy}>
      {state === 'copied' ? <CheckIcon aria-hidden="true" /> : state === 'copying' ? <LoaderCircleIcon className="timber-spinner" aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </MessageAction>
    <span className={state === 'failed' ? 'timber-copy-feedback timber-copy-error' : 'timber-copy-feedback'} role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy. Try again.' : ''}</span>
    {createdAt && <time dateTime={createdAt} title={new Date(createdAt).toLocaleString()}>{time(createdAt)}</time>}
  </MessageActions>;
}

function ApprovalEntry({ approval, current, automatic, callbacks }: { approval: ChatApproval; current: boolean; automatic: boolean; callbacks: ChatCallbacks }) {
  const pending = approval.status === 'pending';
  const executing = approval.status === 'executing' || approval.status === 'approved';
  const title = pending ? `Approval required · ${approval.action.type}` : approval.status === 'interrupted' ? `Interrupted action · ${approval.action.type}` : `${label(approval.status).replace(/^./, character => character.toUpperCase())} action · ${approval.action.type}`;
  const content = <Tool open className="timber-approval-tool">
    <ToolContent className="timber-approval-content">
      <div className="timber-approval-heading"><ShieldCheckIcon aria-hidden="true" /><strong>{title}</strong><time>{time(approval.createdAt)}</time></div>
      <pre className="timber-action"><code>{actionText(approval)}</code></pre>
      {pending && <Confirmation approval={{id: approval.id}} state="approval-requested" className="timber-confirmation">
        <ConfirmationActions className="timber-approval-actions">
          <ConfirmationAction disabled={approval.busy} variant="outline" data-approval-decision="deny" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'deny')}>Deny</ConfirmationAction>
          <ConfirmationAction disabled={approval.busy} data-approval-decision="approve" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve')}>{approval.busy ? 'Working…' : 'Approve'}</ConfirmationAction>
          {!automatic && <ConfirmationAction disabled={approval.busy} variant="secondary" className="timber-approve-allow" data-approval-decision="approve-and-allow" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve', true)}>Approve and allow computer use</ConfirmationAction>}
        </ConfirmationActions>
        {!automatic && <p className="timber-approval-help">“Approve and allow” includes future commands, file changes and desktop actions for this bot.</p>}
      </Confirmation>}
      {executing && <p className="timber-approval-help"><LoaderCircleIcon className="timber-spinner" aria-hidden="true" /> Approved action is executing</p>}
      {approval.status === 'expired' && <p className="timber-approval-help">This request expired.</p>}
      {approval.result?.error && <p className={approval.result.status === "completed" ? "timber-save-warning" : "timber-inline-error"}>{approval.result.error}</p>}
      {['failed', 'interrupted'].includes(approval.status) && <p className="timber-approval-help">Inspect its effects before retrying. This action will not be replayed automatically.</p>}
      {approval.result?.output && <pre className="timber-action timber-result-output"><code>{approval.result.output}</code></pre>}
      {!pending && <p className="timber-operation">Operation ID: {approval.operationId}</p>}
    </ToolContent>
  </Tool>;
  const attributes = {'data-approval-id': approval.id, 'data-approval-status': approval.status};
  return <article className="timber-approval-entry" data-timeline-approval={approval.id} data-run-id={approval.runId}>
    {current ? <div id="current-approval" {...attributes}>{content}</div> : <details className="timber-approval-history" data-approval-history-id={approval.id}>
      <summary><WrenchIcon aria-hidden="true" /><span>{title}</span><time>{time(approval.createdAt)}</time></summary>
      <div {...attributes}>{content}</div>
    </details>}
  </article>;
}

function MessageRunStatus({ model, runId, callbacks }: { model: ChatModel; runId?: string; callbacks: ChatCallbacks }) {
  const run = model.runs.find(item => item.id === runId);
  // The inline request or activity already explains an active task. Keep the
  // receipt only when it adds delivery, failure or cancellation information.
  if (!run || run.status !== 'queued') return null;
  return <div className="timber-message-run" data-message-run-status={run.status}>
    <span className="timber-delivery-status"><ClockIcon />Queued</span>
    {run.error && <div className="timber-delivery-error"><p>{run.error}</p>{run.status === 'queued' && run.error.includes('Retry this message') && <Button variant="outline" size="sm" disabled={model.sending} onClick={() => callbacks.onRetry(model.bot.id, run.operationId)}>Retry sending</Button>}</div>}
  </div>;
}

function TaskOutcome({model, run, callbacks}: {model:ChatModel;run:ChatModel['runs'][number];callbacks:ChatCallbacks}) {
  const request = model.messages.find(message=>message.runId===run.id && message.role==='user');
  const canContinue = request && run.status !== 'cancelled';
  return <article className="timber-task-outcome" data-run-outcome={run.id} role="status">
    <div className="timber-task-outcome-heading"><CircleAlertIcon aria-hidden="true"/><span>{run.status==='cancelled' ? 'Task stopped' : 'Response interrupted'}</span></div>
    {run.error && <p>{run.error}</p>}
    {canContinue && <Button type="button" variant="outline" size="sm" disabled={model.sending || model.runs.some(item=>!terminal.has(item.status))} onClick={()=>callbacks.onSend(model.bot.id, `Continue this task:\n\n${bounded(request.text,6000)}\n\nUse the results already recorded in this conversation. Check the last outcome before taking another action; do not repeat completed work. Explain the result or any remaining blocker.`)}>Continue</Button>}
  </article>;
}

function ConnectionEntry({ connection, callbacks }: { connection: ChatConnection; callbacks: ChatCallbacks }) {
  const pending = connection.status === 'pending';
  return <article className="timber-connection-entry" data-connection-id={connection.id} data-connection-status={connection.status} data-run-id={connection.runId}>
    <div className="timber-connection-heading"><GitBranchIcon aria-hidden="true" /><strong>{pending ? 'Connect GitHub to continue' : connection.status === 'connected' ? 'GitHub access connected' : 'GitHub request cancelled'}</strong><time>{time(connection.createdAt)}</time></div>
    {connection.repository && <p className="timber-connection-repository">{connection.repository}</p>}
    {pending && <p className="timber-connection-scope">{!connection.repository ? 'One connection for all your bots.' : connection.permission === 'write' ? 'Read and write access needed.' : 'Read access needed.'}</p>}
    {pending && <>
      <Button disabled={connection.busy} data-connect-github onClick={() => callbacks.onConnect(connection.botId, connection.id)}>{connection.busy ? <LoaderCircleIcon className="timber-spinner" /> : <ExternalLinkIcon />}{connection.busy ? 'Opening GitHub…' : connection.opened ? 'Continue in GitHub' : 'Connect GitHub'}</Button>
      {connection.opened && <p className="timber-approval-help">Finish in GitHub. This task will resume automatically.</p>}
    </>}
    {connection.error && <p className="timber-inline-error" role="alert">{connection.error}</p>}
  </article>;
}

function DeliveryEntry({ delivery, busy, callbacks }: { delivery: MessageDelivery; busy: boolean; callbacks: ChatCallbacks }) {
  const state = delivery.state === 'sending' ? 'Sending' : delivery.state === 'unknown' ? 'Delivery unknown' : delivery.state === 'rejected' ? 'Not accepted' : delivery.runStatus === 'queued' ? 'Queued' : label(delivery.runStatus || 'queued').replace(/^./, character => character.toUpperCase());
  return <Message from="user" data-operation-id={delivery.operationId} className="timber-message timber-delivery">
    <MessageContent className="timber-message-content"><Response text={delivery.text} /></MessageContent>
    <CopyMessage text={delivery.text} kind="pending" />
    <div className="timber-delivery-status" role="status">
      {delivery.state === 'sending' ? <LoaderCircleIcon className="timber-spinner" /> : delivery.state === 'accepted' ? <CheckIcon /> : <CircleAlertIcon />}
      <span>{state}</span><time>{time(delivery.createdAt)}</time>
    </div>
    {delivery.error && <div className="timber-delivery-error"><p>{delivery.error}</p>{delivery.canRetry && <Button variant="outline" size="sm" disabled={busy} onClick={() => callbacks.onRetry(delivery.botId, delivery.operationId)}>Retry sending</Button>}</div>}
  </Message>;
}

type TimelineEntry = { key: string; at: number; order: number; node: ReactNode };
type ToolActivity = { key: string; runId?: string; at: number; name: string; aliases: Set<string>; returned: boolean; status?: string; result?: {status?: string; output?: string; error?: string; exitCode?: number; artifactId?: string}; data: Record<string, unknown> };
type ActivityStep = {at: number; key: string; tool: ToolActivity};
type ActivityModel = Pick<ChatModel, 'bot' | 'events' | 'runs' | 'approvals' | 'runFilter'>;
const toolNames: Record<string, string> = {exec: 'Run command', read_file: 'Read file', readFile: 'Read file', write_file: 'Write file', writeFile: 'Write file', list_files: 'Browse files', listFiles: 'Browse files', desktop_screenshot: 'Capture desktop', screenshot: 'Capture desktop', browser_navigate: 'Open', navigate: 'Open', desktop_click: 'Click', click: 'Click', desktop_move: 'Move pointer', move: 'Move pointer', desktop_double_click: 'Double click', doubleClick: 'Double click', desktop_drag: 'Drag', drag: 'Drag', desktop_type: 'Type text', type: 'Type text', desktop_key: 'Press', key: 'Press', desktop_scroll: 'Scroll', scroll: 'Scroll', checkpoint: 'Save workspace', github_clone: 'Clone', gitClone: 'Clone', github_push: 'Push', gitPush: 'Push', github_connect: 'Connect GitHub', github_create_pull_request: 'Create pull request', github_list_pull_requests: 'List pull requests', github_list_repositories: 'List repositories', load_skill: 'Load skill', list_tools: 'Available tools', publish_app: 'Publish app', list_apps: 'List apps', remove_app: 'Remove app'};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
// The host publishes an allowlisted input summary. Historical events may have
// no input at all; never invent the command from its result or operation ID.
const toolInput = (tool: ToolActivity) => record(tool.data.input || tool.data.action || tool.data.arguments);
const displayText = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const bounded = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
const privateInput = /^(?:content|text|body|token|secret|password|authorization|credential|api[_-]?key)$/i;
function publicToolData(tool: ToolActivity) {
  // Input bodies and typed text are not useful in a diagnostic disclosure and
  // can contain credentials even when the enclosing property is innocuous.
  return {...tool.data, ...Object.fromEntries(['input', 'action', 'arguments'].filter(key => tool.data[key]).map(key => [key, Object.fromEntries(Object.entries(record(tool.data[key])).map(([name, value]) => [name, privateInput.test(name) ? '[hidden]' : value]))]))};
}

function collectTools(model: ActivityModel, includeApprovals = false): ToolActivity[] {
  // A host event bridges the native call ID and the durable computer operation ID.
  // Merge those explicit aliases only: identical command text is not identity.
  const aliases = new Map<string, ToolActivity>();
  for (const event of model.events) {
    if (!['tool.started', 'tool.completed'].includes(event.type) || model.runFilter && event.runId !== model.runFilter) continue;
    const data = event.data, ids = [data.operationId, data.toolCallId].filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (!ids.length) continue;
    const keys = ids.map(id => `${event.runId || ''}:${id}`), matches = [...new Set(keys.map(key => aliases.get(key)).filter((tool): tool is ToolActivity => Boolean(tool)))];
    const tool = matches[0] || {key: keys[0], runId: event.runId, at: timestamp(event.createdAt), name: 'Computer tool', aliases: new Set<string>(), returned: false, data: {}};
    for (const merged of matches.slice(1)) {
      tool.at = Math.min(tool.at, merged.at); tool.returned ||= merged.returned;
      if (!tool.result && merged.result) tool.result = merged.result;
      if (!tool.status && merged.status) tool.status = merged.status;
      tool.data = {...merged.data, ...tool.data};
      if (tool.name === 'Computer tool' || tool.name === 'call_tool') tool.name = merged.name;
      for (const alias of merged.aliases) {tool.aliases.add(alias); aliases.set(alias, tool);}
    }
    for (const key of keys) {tool.aliases.add(key); aliases.set(key, tool);}
    if (typeof data.actionType === 'string') tool.name = data.actionType;
    else if (typeof data.toolName === 'string' && (data.toolName !== 'call_tool' || tool.name === 'Computer tool')) tool.name = data.toolName;
    tool.returned ||= event.type === 'tool.completed';
    if (typeof data.status === 'string') tool.status = data.status;
    if (data.result && typeof data.result === 'object') tool.result = {...tool.result, ...data.result as ToolActivity['result']};
    tool.data = {...tool.data, ...data};
  }
  for (const approval of model.approvals) {
    if (model.runFilter && approval.runId !== model.runFilter) continue;
    const key = `${approval.runId}:${approval.operationId}`, tool = aliases.get(key);
    if (!includeApprovals) {
      if (tool) for (const alias of tool.aliases) aliases.delete(alias);
      continue;
    }
    const value: ToolActivity = tool || {key, runId: approval.runId, at: timestamp(approval.createdAt), name: approval.action.type, aliases: new Set([key]), returned: false, data: {}};
    value.data = {...value.data, operationId: approval.operationId, input: approval.action};
    value.status = approval.status === 'pending' ? 'pending_approval' : ['approved', 'executing'].includes(approval.status) ? 'running' : approval.status;
    value.returned = !['pending', 'approved', 'executing'].includes(approval.status);
    if (approval.result) value.result = approval.result;
    aliases.set(key, value);
  }
  return [...new Set(aliases.values())];
}

function toolPresentation(tool: ToolActivity) {
  const input = toolInput(tool), value = (key: string) => displayText(input[key]);
  let title = toolNames[tool.name] || label(tool.name), parameters: string[] = [], command = false;
  if (tool.name === 'exec') {
    title = value('command') || 'Run command'; command = Boolean(value('command'));
    if (value('timeoutMs')) parameters.push(`timeout ${Number(input.timeoutMs) / 1000}s`);
    if (value('cwd')) parameters.push(value('cwd'));
  } else if (['read_file', 'readFile', 'write_file', 'writeFile', 'list_files', 'listFiles'].includes(tool.name)) {
    if (value('path')) title = `${tool.name === 'read_file' || tool.name === 'readFile' ? 'Read' : tool.name === 'write_file' || tool.name === 'writeFile' ? 'Write' : 'Browse'} ${value('path')}`;
  } else if (['desktop_click', 'click', 'desktop_double_click', 'doubleClick', 'desktop_move', 'move'].includes(tool.name)) {
    if (value('x') && value('y')) title += ` (${value('x')}, ${value('y')})`;
    if (!['desktop_move', 'move'].includes(tool.name)) parameters.push(`${value('button') || 'left'} button`);
  } else if (['desktop_drag', 'drag'].includes(tool.name)) {
    if (['fromX', 'fromY', 'toX', 'toY'].every(key => value(key))) title += ` (${value('fromX')}, ${value('fromY')}) → (${value('toX')}, ${value('toY')})`;
    parameters.push(`${value('button') || 'left'} button`);
    if (value('durationMs')) parameters.push(`${value('durationMs')}ms`);
  } else if (['desktop_scroll', 'scroll'].includes(tool.name)) {
    if (value('direction')) title += ` ${value('direction')}`;
    if (value('amount')) parameters.push(`${value('amount')} steps`);
  } else if (['desktop_type', 'type'].includes(tool.name)) {
    parameters.push(value('characters') ? `${value('characters')} characters · input hidden` : 'Input hidden');
  } else if (['desktop_key', 'key'].includes(tool.name)) {
    if (value('key')) title += ` ${value('key')}`;
  } else if (['browser_navigate', 'navigate'].includes(tool.name)) {
    if (value('url')) title += ` ${value('url')}`;
  } else {
    if (value('repository')) title += ` ${value('repository')}`;
    else if (value('name')) title += ` ${value('name')}`;
    else if (value('appId')) title += ` ${value('appId')}`;
    for (const key of ['path', 'branch', 'head', 'base', 'permission', 'port', 'page']) if (value(key)) parameters.push(`${key} ${value(key)}`);
  }
  return {title: bounded(title, 900), parameters: parameters.join(' · '), command};
}

function toolState(tool: ToolActivity, model: ActivityModel) {
  const run = model.runs.find(item => item.id === tool.runId), active = Boolean(run && !terminal.has(run.status));
  const status = tool.result?.status || tool.status;
  const pending = status === 'pending_approval' || status === 'pending_connection';
  const running = (!tool.returned && !status || status === 'running') && active;
  const unknown = !tool.returned && (!status || status === 'running') && !active;
  const failed = ['failed', 'interrupted', 'cancelled', 'denied', 'expired'].includes(status || '') || unknown;
  const text = unknown ? 'Outcome unconfirmed' : status === 'pending_connection' ? 'Connection requested' : pending ? 'Approval requested' : status === 'completed' ? 'Completed' : running ? 'Running' : status ? label(status).replace(/^./, character => character.toUpperCase()) : 'Returned';
  return {status: status || (unknown ? 'unconfirmed' : running ? 'running' : 'returned'), text, running, failed, pending};
}

function ToolActivityRow({tool, model, panel = false}: {tool: ToolActivity; model: ActivityModel; panel?: boolean}) {
  const [expanded, setExpanded] = useState(false), [detail, setDetail] = useState<'output'|'command'|'details'|null>(null);
  const state = toolState(tool, model), presentation = toolPresentation(tool), input = toolInput(tool);
  const command = presentation.command ? displayText(input.command) : '';
  const identity = activityIdentity(tool.name, command), Icon = identity.Icon;
  const StatusIcon = state.running ? LoaderCircleIcon : state.failed ? CircleAlertIcon : state.pending ? ShieldCheckIcon : CheckIcon;
  const output = typeof tool.result?.output === 'string' ? tool.result.output : '';
  const error = tool.result?.error;
  const format = useMemo(()=>outputFormat(output, tool.name, {path: input.path}), [output, tool.name, input.path]);
  const preview = error || (tool.result?.artifactId ? 'Image captured' : tool.name === 'exec' && state.status === 'completed' && !output.trim() ? 'No output' : '');
  const operation = String(tool.data.operationId || tool.data.toolCallId || tool.key);
  const attributes = panel ? {'data-activity-tool-operation-id': operation} : {'data-tool-operation-id': operation};
  const statusLabel = `${state.text}${tool.result?.exitCode !== undefined ? ` · exit ${tool.result.exitCode}` : ''}`;
  const tabs = [...(output ? ['output' as const] : []), ...(command ? ['command' as const] : []), 'details' as const];
  const selected = detail && tabs.includes(detail) ? detail : tabs[0];
  return <details className={`timber-tool-row${state.failed ? ' timber-tool-error' : ''}`} {...attributes} data-tool-status={state.status} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary className="timber-tool-summary" title="Show full output and details">
      <span className="timber-tool-kind" title={identity.label} aria-label={identity.label}><Icon aria-hidden="true"/></span>
      <div className="timber-tool-overview">
        <div className={`timber-tool-command${presentation.command ? ' is-command' : ''}`}>{command ? <ActivityCode code={command} language="bash" compact/> : presentation.title}</div>
        <div className="timber-tool-meta"><span className={state.pending || state.status === 'unconfirmed' ? 'timber-tool-parameters' : 'timber-sr-only'}>{statusLabel}</span>{tool.result?.exitCode !== undefined && tool.result.exitCode !== 0 && <span className="timber-tool-exit">exit {tool.result.exitCode}</span>}{presentation.parameters && <span className="timber-tool-parameters">{presentation.parameters}</span>}</div>
        {preview ? <div className={`timber-tool-preview${error ? tool.result?.status === 'completed' ? ' timber-save-warning' : ' timber-inline-error' : ''}`} data-tool-result-preview>{bounded(preview,420)}</div> : output.trim() && <div className="timber-tool-preview" data-tool-result-preview><ActivityOutput format={format} compact/></div>}
      </div>
      <span className="timber-tool-corner"><span className="timber-tool-status" role="status" aria-label={statusLabel} title={statusLabel}><StatusIcon className={state.running ? 'timber-spinner' : ''} aria-hidden="true"/></span><ChevronDownIcon className="timber-tool-chevron" aria-hidden="true"/></span>
    </summary>
    {expanded && <div className="timber-tool-expanded">
      <div className="timber-tool-tabs" role="group" aria-label="Action detail">{tabs.map(tab=><button type="button" key={tab} aria-pressed={selected===tab} onClick={()=>setDetail(tab)}>{tab==='details' ? 'Details' : tab==='command' ? 'Command' : 'Output'}</button>)}</div>
      {selected === 'output' && <div className="timber-tool-output"><ActivityOutput format={format} source={output}/></div>}
      {selected === 'command' && <ActivityCode code={command} language="bash"/>}
      {selected === 'details' && <div className="timber-tool-data"><ActivityCode code={safeJSON(publicToolData(tool))} language="json"/></div>}
      {error && <p className={tool.result?.status === 'completed' ? 'timber-save-warning' : 'timber-inline-error'}>{error}</p>}
    </div>}
  </details>;
}

function responseRetry(model: ActivityModel, runId?: string) {
  const events = model.events.filter(event=>event.runId===runId && ['run.retrying','tool.started'].includes(event.type));
  const last = events.at(-1);
  return last?.type==='run.retrying' ? `Retrying response · ${last.data.attempt}/${last.data.maxRetries}` : null;
}

function ActivityGroup({model, runId, steps}: {model: ActivityModel; runId?: string; steps: ActivityStep[]}) {
  const run = model.runs.find(item => item.id === runId), working = run?.status === 'running';
  return <section className="timber-activity-group" data-run-activity={runId || 'unassigned'} aria-label="Activity">
    <div className="timber-activity-header"><ActivityIcon aria-hidden="true" /><span>Activity</span><span className="timber-activity-count">{steps.length} {steps.length === 1 ? 'action' : 'actions'}</span>{working && <span className="timber-activity-status" role="status"><LoaderCircleIcon className="timber-spinner" aria-hidden="true" />{responseRetry(model,runId) || 'Working'}</span>}</div>
    <div className="timber-activity-content">{[...steps].sort((a, b) => a.at - b.at).map(step => <ToolActivityRow key={step.key} tool={step.tool} model={model} />)}</div>
  </section>;
}

function ActivityPanel({model}: {model: ActivityModel}) {
  const tools = collectTools(model, true).sort((a, b) => Number(toolState(b, model).running) - Number(toolState(a, model).running) || b.at - a.at);
  return <div className="timber-activity-panel">{tools.length ? tools.map(tool => <ToolActivityRow key={tool.key} tool={tool} model={model} panel />) : <p className="timber-activity-empty">No actions yet.</p>}</div>;
}

function timeline(model: ChatModel, callbacks: ChatCallbacks): TimelineEntry[] {
  const messages = model.messages.filter(message => !model.runFilter || message.runId === model.runFilter);
  const approvals = model.approvals.filter(approval => !model.runFilter || approval.runId === model.runFilter);
  const current = [...approvals].filter(approval => ['pending', 'executing', 'approved'].includes(approval.status)).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))[0];
  // The server run identifies a request even before its transcript row loads.
  // Device clock skew and equal timestamps must never put an effect before it.
  const deliveries = model.deliveries.map(delivery => {
    const run = model.runs.find(run => run.operationId === delivery.operationId);
    return {...delivery, runId: delivery.runId || run?.id, createdAt: run?.createdAt || delivery.createdAt};
  }).filter(delivery => (!model.runFilter || delivery.runId === model.runFilter) &&
    !messages.some(message => message.role === 'user' && message.runId && message.runId === delivery.runId));
  const requests = new Map<string, {at: number; order: number}>();
  messages.forEach((message, index) => {if (message.role === 'user' && message.runId) requests.set(message.runId, {at: timestamp(message.createdAt), order: index * 2});});
  deliveries.forEach((delivery, index) => {if (delivery.runId) requests.set(delivery.runId, {at: timestamp(delivery.createdAt), order: (messages.length + index) * 2});});
  const afterRequest = (runId: string | undefined, createdAt: number) => {
    const request = runId ? requests.get(runId) : undefined;
    const at = Math.max(createdAt, request?.at || 0);
    return {at, order: request && request.at === at ? request.order + 1 : (messages.length + deliveries.length) * 2 + 1};
  };
  const entries: TimelineEntry[] = [], groups = new Map<string, {runId?: string; steps: ActivityStep[]}>();
  const addActivity = (runId: string | undefined, step: ActivityStep) => {const key = runId || step.key, group = groups.get(key) || {runId, steps: []}; group.steps.push(step); groups.set(key, group);};
  messages.forEach((message, index) => {
    // Progress is public assistant text accompanying a tool call. It belongs in
    // the transcript just like a final answer, never in a reasoning disclosure.
    const request = message.role === 'assistant' && message.runId ? requests.get(message.runId) : undefined;
    const at = Math.max(timestamp(message.createdAt), request?.at || 0);
    entries.push({key: `message:${message.id}`, at, order: Math.max(index * 2, request && request.at === at ? request.order + 2 : 0), node: <Message from={message.role === 'user' ? 'user' : 'assistant'} data-message-id={message.id} data-message-kind={message.kind} data-progress-message-id={message.kind === 'progress' ? message.id : undefined} data-run-id={message.runId} className={`timber-message timber-message-${message.role}`}>
      {message.role !== 'user' && <div className="timber-message-meta"><span>{message.role === 'assistant' ? model.bot.name : label(message.role)}</span></div>}
      <MessageContent className="timber-message-content"><Response text={message.text} /></MessageContent>
      {['user', 'assistant'].includes(message.role) && <CopyMessage text={message.text} createdAt={message.createdAt} />}
      {message.role === 'user' && <MessageRunStatus model={model} runId={message.runId} callbacks={callbacks} />}
    </Message>});
  });
  for (const approval of approvals) entries.push({key: `approval:${approval.id}`, ...afterRequest(approval.runId, timestamp(approval.createdAt)), node: <ApprovalEntry approval={approval} current={approval.id === current?.id} automatic={model.bot.computerApprovalMode === 'automatic'} callbacks={callbacks} />});
  for (const connection of model.connections.filter(item => !model.runFilter || item.runId === model.runFilter)) {
    entries.push({key: `connection:${connection.id}`, ...afterRequest(connection.runId, timestamp(connection.createdAt)), node: <ConnectionEntry connection={connection} callbacks={callbacks} />});
  }
  deliveries.forEach((delivery, index) => entries.push({key: `delivery:${delivery.operationId}`, at: timestamp(delivery.createdAt), order: (messages.length + index) * 2, node: <DeliveryEntry delivery={delivery} busy={model.sending} callbacks={callbacks} />}));
  for (const tool of collectTools(model)) addActivity(tool.runId, {tool, key: tool.key, at: tool.at});
  for (const [key, group] of groups) entries.push({key: `activity:${key}`, ...afterRequest(group.runId, Math.min(...group.steps.map(step => step.at))), node: <ActivityGroup model={model} runId={group.runId} steps={group.steps} />});
  for (const run of model.runs.filter(run=>['failed','interrupted','cancelled'].includes(run.status) && (!model.runFilter || model.runFilter===run.id))) {
    const at = Math.max(requests.get(run.id)?.at || 0, timestamp(run.updatedAt), ...messages.filter(message=>message.runId===run.id).map(message=>timestamp(message.createdAt)), ...model.events.filter(event=>event.runId===run.id).map(event=>timestamp(event.createdAt)));
    entries.push({key:`outcome:${run.id}`,at,order:(messages.length + deliveries.length)*2+4,node:<TaskOutcome model={model} run={run} callbacks={callbacks}/>});
  }
  return entries.sort((a, b) => a.at - b.at || a.order - b.order);
}

function ConversationBody({ model, callbacks }: { model: ChatModel; callbacks: ChatCallbacks }) {
  const { scrollRef } = useStickToBottomContext();
  const focus = useRef(model.focusApproval);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {node.id = 'messages'; node.setAttribute('aria-label', `${model.bot.name} conversation`);}
  }, [model.bot.id, scrollRef]);
  useEffect(() => {
    if (focus.current === model.focusApproval) return;
    focus.current = model.focusApproval;
    const card = scrollRef.current?.querySelector<HTMLElement>('#current-approval');
    card?.scrollIntoView({block: 'center', behavior: 'instant'});
    card?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
  }, [model.focusApproval, scrollRef]);
  const entries = timeline(model, callbacks);
  const visibleRun = model.currentRun && (!model.runFilter || model.runFilter === model.currentRun.id) ? model.currentRun : null;
  const hasInlineStatus = visibleRun && (
    model.approvals.some(item => item.runId === visibleRun.id && ['pending', 'executing', 'approved'].includes(item.status)) ||
    model.connections.some(item => item.runId === visibleRun.id && item.status === 'pending') ||
    (visibleRun.status === 'queued' && model.messages.some(item => item.runId === visibleRun.id && item.role === 'user')) ||
    (visibleRun.status === 'running' && collectTools(model).some(item => item.runId === visibleRun.id))
  );
  return <>
    <ConversationContent className="timber-conversation-content">
      {!entries.length && <ConversationEmptyState className="timber-chat-empty" title={model.loading ? 'Loading…' : `Ask ${model.bot.name}`} description="" />}
      {entries.map(entry => <div className="timber-timeline-entry" key={entry.key}>{entry.node}</div>)}
      {model.feedback && (!model.runFilter || model.feedback.runId === model.runFilter) && <div id="approval-feedback" role="status" className={model.feedback.error ? 'timber-feedback timber-inline-error' : 'timber-feedback'}>{model.feedback.text}</div>}
      {model.stream && <Message from="assistant" id="streaming-message" className="timber-message" data-run-id={model.stream.runId}>
        <div className="timber-message-meta"><span>{model.bot.name}</span><span className="timber-responding"><LoaderCircleIcon className="timber-spinner" /> Responding</span></div>
        <MessageContent className="timber-message-content"><div id="streaming-text"><Response text={model.stream.text} streaming /></div></MessageContent>
        <CopyMessage text={model.stream.text} kind="streaming" />
      </Message>}
      {!model.stream && visibleRun && !terminal.has(visibleRun.status) && !hasInlineStatus && <div className="timber-work-status" role="status">
        {visibleRun.status === 'waiting_connection' ? <GitBranchIcon /> : visibleRun.status === 'waiting_approval' ? <ShieldCheckIcon /> : visibleRun.status === 'queued' ? <ClockIcon /> : <LoaderCircleIcon className="timber-spinner" />}
        <span>{visibleRun.status === 'waiting_connection' ? 'Waiting for GitHub access' : visibleRun.status === 'waiting_approval' ? 'Waiting for your approval' : visibleRun.status === 'queued' ? 'Queued' : responseRetry(model,visibleRun.id) || `${model.bot.name} is working`}</span>
      </div>}
      {visibleRun?.error && !model.messages.some(message => message.role === 'user' && message.runId === visibleRun.id) && <div className="timber-delivery-error" role="status"><p>{visibleRun.error}</p>{visibleRun.status === 'queued' && visibleRun.error.includes('Retry this message') && <Button variant="outline" size="sm" disabled={model.sending} onClick={() => callbacks.onRetry(model.bot.id, visibleRun.operationId)}>Retry sending</Button>}</div>}
    </ConversationContent>
    <ConversationScrollButton aria-label="Jump to latest message" className="timber-jump-bottom" />
  </>;
}

function Composer({ model, callbacks }: { model: ChatModel; callbacks: ChatCallbacks }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '0px';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === input.clientWidth) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [model.draft]);
  return <div className="timber-composer-wrap">
      <PromptInput id="message-form" className="timber-composer" maxFiles={0} onReset={event => event.preventDefault()} onSubmit={({text}) => {if (!model.sending && text.trim()) callbacks.onSend(model.bot.id, text);}}>
        <PromptInputBody><PromptInputTextarea ref={textarea} id="message" rows={1} aria-label={`Message ${model.bot.name}`} placeholder={`Message ${model.bot.name}…`} value={model.draft} onChange={event => callbacks.onDraft(model.bot.id, event.currentTarget.value)} />
          <PromptInputSubmit className="timber-send" aria-label="Send message" title="Send message" disabled={model.sending || !model.draft.trim()}>{model.sending ? <LoaderCircleIcon className="timber-spinner" /> : <ArrowUpIcon />}</PromptInputSubmit>
        </PromptInputBody>
      </PromptInput>
    </div>;
}

function MiniActivity({model, onConversation}: {model: ChatModel; onConversation(): void}) {
  const tools = collectTools({...model, runFilter: null}, true).sort((a,b) => b.at - a.at);
  const active = tools.filter(tool => toolState(tool, model).running);
  const visible = active.length ? active.slice(0, 3) : tools.slice(0, 1);
  const run = model.currentRun, latestRun = [...model.runs].sort((a,b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0];
  const waiting = run?.status === 'waiting_approval' || run?.status === 'waiting_connection';
  const failed = !run && latestRun && ['failed','interrupted'].includes(latestRun.status);
  const reply = model.stream?.text || [...model.messages].reverse().find(message => message.role === 'assistant' && message.kind !== 'progress')?.text;
  const delivery = model.deliveries.find(item => ['unknown','rejected'].includes(item.state));
  const heading = delivery ? 'Message not confirmed' : waiting ? 'Needs your attention' : failed ? 'Response interrupted' : run ? responseRetry(model,run.id) || (model.stream ? 'Responding' : 'Working') : reply ? 'Reply ready' : 'Activity';
  return <button className="timber-mini-activity" type="button" onClick={onConversation} aria-label="Open conversation" data-mini-activity>
    <span className="timber-mini-heading"><strong>{model.bot.name}</strong><span role="status">{heading}</span><ExternalLinkIcon aria-hidden="true"/></span>
    {visible.map(tool => {const state = toolState(tool,model), presentation = toolPresentation(tool); const StatusIcon = state.running ? LoaderCircleIcon : state.failed ? CircleAlertIcon : state.pending ? ShieldCheckIcon : CheckIcon;
      return <span className="timber-mini-step" key={tool.key} title={`${presentation.title} · ${state.text}`}><StatusIcon className={state.running ? 'timber-spinner' : ''} aria-hidden="true"/><span>{presentation.title}</span><small>{state.text}</small></span>;
    })}
    {(delivery || waiting || failed || model.stream || (!run && reply)) && <span className="timber-mini-reply">{delivery?.error || (waiting ? 'Open conversation to continue' : failed ? latestRun?.error : reply)}</span>}
  </button>;
}

function Chat({ model, callbacks, dockTarget, onConversation }: { model: ChatModel; callbacks: ChatCallbacks; dockTarget: HTMLElement | null; onConversation(): void }) {
  const composer = <Composer model={model} callbacks={callbacks}/>;
  return <div className="timber-chat-layout">
    {model.runFilter && <div id="run-filter" className="timber-filter"><span>Filtered by task</span><Button id="clear-run-filter" variant="ghost" size="sm" onClick={callbacks.onClearFilter}>Show all messages</Button></div>}
    <Conversation className="timber-conversation" initial="instant" resize="instant"><ConversationBody model={model} callbacks={callbacks} /></Conversation>
    {dockTarget ? createPortal(<div className="timber-focus-chat"><MiniActivity model={model} onConversation={onConversation}/>{composer}</div>, dockTarget) : composer}
  </div>;
}


export function mountChat(element: HTMLElement, callbacks: ChatCallbacks, onConversation: () => void) {
  const root = createRoot(element);
  let model: ChatModel | null = null, dockTarget: HTMLElement | null = null;
  const render = () => root.render(model ? <Chat key={model.bot.id} model={model} callbacks={callbacks} dockTarget={dockTarget} onConversation={onConversation}/> : null);
  return {
    update(value: ChatModel) {model = value; render();},
    setDock(target: HTMLElement | null) {if (dockTarget !== target) {dockTarget = target; render();}},
    clear() {model = null; render();},
  };
}

export function mountToolActivity(element: HTMLElement) {
  const root = createRoot(element);
  return { update(model: ActivityModel) {root.render(<ActivityPanel key={model.bot.id} model={model} />);}, clear() {root.render(null);} };
}
