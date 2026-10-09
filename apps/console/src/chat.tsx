import { useEffect, useLayoutEffect, useMemo, useRef, useState, useId, memo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { XIcon, PaperclipIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, ClockIcon, CopyIcon, LoaderCircleIcon, ShieldCheckIcon, ActivityIcon, WrenchIcon, GitBranchIcon, ExternalLinkIcon, HistoryIcon, SquareIcon } from 'lucide-react';
import { defaultUrlTransform, type UrlTransform } from 'streamdown';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton, useConversationContext } from '@/components/ai-elements/conversation';
import { Message, MessageActions, MessageAction, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea, usePromptInputAttachments } from '@/components/ai-elements/prompt-input';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { Confirmation, ConfirmationAction, ConfirmationActions } from '@/components/ai-elements/confirmation';
import { Button } from '@/components/ui/button';
import type { ChatApproval, ChatCallbacks, ChatModel, ChatConnection, MessageDelivery } from './chat-types';
import {canRetryAdmission} from './run-recovery';
import {failureRecovery} from './failure-recovery';
import {ActivityCode, ActivityOutput, activityIdentity, outputFormat} from './activity-content';
import {ArtifactPreview, ArtifactProvider, type ArtifactLoader} from './artifact-preview';
import './chat.css';
import {hasBotMention} from './mentions';
import {agentColor} from './agent-colors';
import {AgentCreationCard, AgentMessageNotice, collectCollaboration, type CollaborationItem} from './collaboration-timeline';
import {ModelSettings} from './model-settings';
import {ModelBadge} from './model-identity';
import {ContextMemoryControl} from './context-memory';
import {collectCompactions, CompactionPill, type CompactionItem} from './compaction-timeline';
import {mergeToolResult, mergeToolStatus, runOutcomes, toolActivityState, toolFailureSummary} from './cancellation-presentation';

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
const responsePlugins = {};
const responseUrlTransform: UrlTransform = (url, key, node) => url === 'streamdown:incomplete-link' ? undefined : defaultUrlTransform(url, key, node);

const Response = memo(function Response({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MessageResponse className="timber-markdown" mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} parseIncompleteMarkdown skipHtml plugins={responsePlugins} components={responseComponents} linkSafety={responseLinkSafety} urlTransform={responseUrlTransform} controls={false}>{text}</MessageResponse>;
});

const CopyMessage = memo(function CopyMessage({ text, kind = 'message', createdAt }: { text: string; kind?: 'message' | 'pending' | 'streaming'; createdAt?: string }) {
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
});

const ApprovalEntry = memo(function ApprovalEntry({ approval, current, automatic, callbacks, agentName, process }: { approval: ChatApproval; current: boolean; automatic: boolean; callbacks: ChatCallbacks; agentName?:string; process?: ChatModel['events'][number] }) {
  if (process) approval = {...approval, result: mergeToolResult(approval.result, process.data.result as ChatApproval['result'], {snapshot:true})};
  const saving = approval.result?.checkpointStatus === 'pending';
  const pending = approval.status === 'pending';
  const executing = approval.status === 'executing' || approval.status === 'approved' || approval.result?.status === 'running';
  const processStatus = approval.result?.processId ? approval.result.status : undefined;
  const actionStatus = processStatus || approval.status;
  const title = pending ? `Approval required · ${approval.action.type}` : processStatus === 'running' && process?.data.cancellationRequested ? `Stopping action · ${approval.action.type}` : `${label(actionStatus).replace(/^./, character => character.toUpperCase())} action · ${approval.action.type}`;
  const content = <Tool open className="timber-approval-tool">
    <ToolContent className="timber-approval-content">
      <div className="timber-approval-heading"><ShieldCheckIcon aria-hidden="true" /><strong>{agentName ? `${agentName} · ${title}` : title}</strong><time>{time(approval.createdAt)}</time></div>
      <pre className="timber-action"><code>{actionText(approval)}</code></pre>
      {pending && <Confirmation approval={{id: approval.id}} state="approval-requested" className="timber-confirmation">
        <ConfirmationActions className="timber-approval-actions">
          <ConfirmationAction disabled={approval.busy} variant="outline" data-approval-decision="deny" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'deny')}>Deny</ConfirmationAction>
          <ConfirmationAction disabled={approval.busy} data-approval-decision="approve" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve')}>{approval.busy ? 'Working…' : 'Approve'}</ConfirmationAction>
          {!automatic && <ConfirmationAction disabled={approval.busy} variant="secondary" className="timber-approve-allow" data-approval-decision="approve-and-allow" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve', true)}>Approve and allow computer use</ConfirmationAction>}
        </ConfirmationActions>
        {!automatic && <p className="timber-approval-help">“Approve and allow” includes future commands, file changes and desktop actions for this bot.</p>}
      </Confirmation>}
      {executing && <p className="timber-approval-help"><LoaderCircleIcon className="timber-spinner" aria-hidden="true" /> {process?.data.cancellationRequested ? 'Stopping command…' : 'Approved action is executing'}</p>}
      {current && saving && <p className="timber-approval-help" data-checkpoint-status="pending">Saving files…</p>}
      {approval.status === 'expired' && <p className="timber-approval-help">This request expired.</p>}
      {approval.result?.error && <p className={approval.result.status === "completed" ? "timber-save-warning" : "timber-inline-error"}>{approval.result.error}</p>}
      {['failed', 'interrupted'].includes(approval.status) && <p className="timber-approval-help">Inspect its effects before retrying. This action will not be replayed automatically.</p>}
      {approval.result?.output && <pre className="timber-action timber-result-output"><code>{approval.result.output}</code></pre>}
      {!pending && <p className="timber-operation">Operation ID: {approval.operationId}</p>}
    </ToolContent>
  </Tool>;
  const attributes = {'data-approval-id': approval.id, 'data-approval-status': approval.status, 'data-process-status': processStatus};
  return <article className="timber-approval-entry" data-timeline-approval={approval.id} data-run-id={approval.runId}>
    {current ? <div id="current-approval" {...attributes}>{content}</div> : <details className="timber-approval-history" data-approval-history-id={approval.id}>
      <summary><WrenchIcon aria-hidden="true" /><span>{title}</span>{saving && <span className="timber-tool-parameters" data-checkpoint-status="pending">Saving files…</span>}<time>{time(approval.createdAt)}</time></summary>
      <div {...attributes}>{content}</div>
    </details>}
  </article>;
});

function MessageRunStatus({ run, botId, sending, callbacks }: { run?: ChatModel['runs'][number]; botId: string; sending: boolean; callbacks: ChatCallbacks }) {
  // The inline request or activity already explains an active task. Keep the
  // receipt only when it adds delivery, failure or cancellation information.
  if (!run || run.status !== 'queued') return null;
  return <div className="timber-message-run" data-message-run-status={run.status}>
    <span className="timber-delivery-status"><ClockIcon />Queued</span>
    {run.error && <div className="timber-delivery-error"><p>{run.error}</p>{canRetryAdmission(run) && <Button variant="outline" size="sm" disabled={sending} onClick={() => callbacks.onRetry(botId, run.operationId)}>Retry sending</Button>}</div>}
  </div>;
}

const TaskOutcome = memo(function TaskOutcome({botId, run, request, failure, sending, active, callbacks, kind, cancellationId}: {botId:string;run:ChatModel['runs'][number];request?:ChatModel['messages'][number];failure:ReturnType<typeof failureRecovery>;sending:boolean;active:boolean;callbacks:ChatCallbacks;kind:'stopped'|'failure';cancellationId?:string}) {
  if (kind === 'stopped') return <article className="timber-work-status" data-run-outcome={run.id} data-cancellation-id={cancellationId} data-task-outcome-kind="stopped" role="status"><SquareIcon aria-hidden="true"/><span>Task stopped</span></article>;
  const allowanceExhausted=failure.code==='chatgpt_allowance_exhausted',retryable=canRetryAdmission(run)&&!allowanceExhausted;
  const canContinue=Boolean(request)&&!retryable&&['continue','retry'].includes(failure.action);
  const recoveryTarget=['model','connection','context'].includes(failure.action)?failure.action as 'model'|'connection'|'context':undefined;
  return <article className="timber-task-outcome" data-run-outcome={run.id} role="status">
    <div className="timber-task-outcome-heading"><CircleAlertIcon aria-hidden="true"/><span>{allowanceExhausted?'ChatGPT usage limit reached':retryable?'Message not started':run.status==='failed'?'Request failed':'Response interrupted'}</span></div>
    {failure.message && <p>{failure.message}</p>}
    {failure.code&&<details className="timber-failure-details"><summary>Details</summary><code>{failure.code}</code>{run.model&&<p>{run.model}{run.reasoningEffort?` · ${run.reasoningEffort} reasoning`:''}{run.fast?' · Fast':''}</p>}</details>}
    {recoveryTarget&&<Button type="button" variant="outline" size="sm" onClick={()=>callbacks.onRecovery(botId,recoveryTarget)}>{recoveryTarget==='model'?'Review model settings':recoveryTarget==='connection'?'Open Settings':'Review context'}</Button>}
    {allowanceExhausted&&<Button asChild variant="outline" size="sm"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" title="Open ChatGPT usage in a new tab">Open ChatGPT usage<ExternalLinkIcon aria-hidden="true"/></a></Button>}
    {retryable && request && <Button type="button" variant="outline" size="sm" disabled={sending} onClick={()=>callbacks.onRetry(botId,run.operationId)}>Retry sending</Button>}
    {canContinue && request && <Button type="button" variant="outline" size="sm" disabled={sending || active} onClick={()=>callbacks.onSend(botId, `Continue this task:\n\n${bounded(request.text,6000)}\n\nUse the results already recorded in this conversation. Check the last outcome before taking another action; do not repeat completed work. Explain the result or any remaining blocker.`)}>{failure.action==='retry'?'Try again':'Continue'}</Button>}
  </article>;
});

const ConnectionEntry = memo(function ConnectionEntry({ connection, callbacks }: { connection: ChatConnection; callbacks: ChatCallbacks }) {
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
});

const DeliveryEntry = memo(function DeliveryEntry({ delivery, busy, callbacks }: { delivery: MessageDelivery; busy: boolean; callbacks: ChatCallbacks }) {
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
});

type TimelineEntry = { key: string; at: number; order: number; node: ReactNode; tool?: ToolActivity };
type ToolActivity = { key: string; runId?: string; at: number; name: string; aliases: Set<string>; returned: boolean; status?: string; result?: {status?: string; processId?: string; checkpointStatus?: 'pending'|'saved'|'failed'; output?: string; error?: string; exitCode?: number; artifactId?: string}; process?: ChatModel['events'][number]; data: Record<string, unknown> };
type ActivityStep = {at: number; key: string; tool: ToolActivity};
type ActivityModel = Pick<ChatModel, 'bot' | 'events' | 'runs' | 'approvals' | 'runFilter' | 'subagents' | 'delegations' | 'mentionBots' | 'messages' | 'collaborationEvents'>;
const activityFields = ['bot', 'events', 'runs', 'approvals', 'runFilter', 'subagents', 'delegations', 'mentionBots', 'messages', 'collaborationEvents'] as const;
const sameActivityModel = (left: ActivityModel | null, right: ActivityModel) => Boolean(left && activityFields.every(key => left[key] === right[key]));

const toolNames: Record<string, string> = {exec: 'Run command', read_file: 'Read file', readFile: 'Read file', write_file: 'Write file', writeFile: 'Write file', list_files: 'Browse files', listFiles: 'Browse files', desktop_screenshot: 'Capture desktop', screenshot: 'Capture desktop', browser_navigate: 'Open', navigate: 'Open', desktop_click: 'Click', click: 'Click', desktop_move: 'Move pointer', move: 'Move pointer', desktop_double_click: 'Double click', doubleClick: 'Double click', desktop_drag: 'Drag', drag: 'Drag', desktop_type: 'Type text', type: 'Type text', desktop_key: 'Press', key: 'Press', desktop_scroll: 'Scroll', scroll: 'Scroll', checkpoint: 'Save workspace', github_clone: 'Clone', gitClone: 'Clone', github_push: 'Push', gitPush: 'Push', github_connect: 'Connect GitHub', github_create_pull_request: 'Create pull request', github_list_pull_requests: 'List pull requests', github_list_repositories: 'List repositories', load_skill: 'Load skill', list_tools: 'Available tools', publish_app: 'Publish app', list_apps: 'List apps', remove_app: 'Remove app', spawn_subagent:'Create subagent', list_subagents:'View subagents', send_subagent_message:'Message subagent', wait_subagent:'Wait for subagent', cancel_subagent:'Stop subagent', send_to_bot:'Message bot', create_bot:'Create named bot', list_bots:'View bots'};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
Object.assign(toolNames, {exec_poll: 'Check command', execPoll: 'Check command', exec_cancel: 'Stop command', execCancel: 'Stop command'});
// Build these once per history revision, not once per message/tool/approval.
function historyIndexes(model: ActivityModel) {
  const runs = new Map(model.runs.map(run => [run.id, run]));
  const operations = new Map(model.runs.map(run => [run.operationId, run]));
  const agents = new Map(model.subagents.map(agent => [agent.id, agent]));
  const bots = new Map(model.mentionBots.map(bot => [bot.id, bot]));
  const processes = new Map<string, ChatModel['events'][number]>();
  const eventsByRun = new Map<string | undefined, ChatModel['events']>();
  const latestAt = new Map<string | undefined, number>();
  const retries = new Map<string | undefined, string | null>();
  const requests = new Map<string, ChatModel['messages'][number]>();
  for (const message of model.messages) {
    latestAt.set(message.runId, Math.max(latestAt.get(message.runId) || 0, timestamp(message.createdAt)));
    if (message.role === 'user' && message.runId && !requests.has(message.runId)) requests.set(message.runId, message);
  }
  for (const event of model.events) {
    if (event.type === 'process.updated' && typeof event.data.processId === 'string') processes.set(event.data.processId, event);
    const group = eventsByRun.get(event.runId) || [];
    group.push(event); eventsByRun.set(event.runId, group);
    latestAt.set(event.runId, Math.max(latestAt.get(event.runId) || 0, timestamp(event.createdAt)));
    if (event.type === 'run.retrying') retries.set(event.runId, `Retrying response · ${event.data.attempt}/${event.data.maxRetries}`);
    else if (event.type === 'tool.started') retries.set(event.runId, null);
  }
  return {runs, operations, agents, bots, processes, eventsByRun, latestAt, retries, requests};
}
type HistoryIndexes = ReturnType<typeof historyIndexes>;
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

function collectTools(model: ActivityModel, includeApprovals = false, collaboration = collectCollaboration(model), indexes = historyIndexes(model)): ToolActivity[] {
  // A host event bridges the native call ID and the durable computer operation ID.
  // Merge those explicit aliases only: identical command text is not identity.
  const aliases = new Map<string, ToolActivity>();
  const collaborationIdentities=collaboration.toolIdentities;
  for (const event of model.events) {
    if (!['tool.started', 'tool.completed', 'process.updated'].includes(event.type) || event.data.subagentId || model.runFilter && event.runId !== model.runFilter) continue;
    const data = event.data, ids = [data.operationId, data.toolCallId, event.type === 'process.updated' ? data.processId : undefined].filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (!ids.length) continue;
    const keys = ids.map(id => `${event.runId || ''}:${id}`), matches = [...new Set(keys.map(key => aliases.get(key)).filter((tool): tool is ToolActivity => Boolean(tool)))];
    const tool: ToolActivity = matches[0] || {key: keys[0], runId: event.runId, at: timestamp(event.createdAt), name: 'Computer tool', aliases: new Set<string>(), returned: false, data: {}};
    for (const merged of matches.slice(1)) {
      tool.at = Math.min(tool.at, merged.at); tool.returned ||= merged.returned;
      if (!tool.result && merged.result) tool.result = merged.result;
      if (!tool.status && merged.status) tool.status = merged.status;
      if (merged.process && (!tool.process || merged.process.id > tool.process.id)) tool.process = merged.process;
      tool.data = {...merged.data, ...tool.data};
      if (tool.name === 'Computer tool' || tool.name === 'call_tool') tool.name = merged.name;
      for (const alias of merged.aliases) {tool.aliases.add(alias); aliases.set(alias, tool);}
    }
    for (const key of keys) {tool.aliases.add(key); aliases.set(key, tool);}
    if (event.type === 'process.updated') {tool.process = event; tool.name = 'exec';}
    if (typeof data.actionType === 'string') tool.name = data.actionType;
    else if (typeof data.toolName === 'string' && (data.toolName !== 'call_tool' || tool.name === 'Computer tool')) tool.name = data.toolName;
    tool.returned ||= event.type === 'tool.completed';
    const previous = tool.result, previousStatus = previous?.status || tool.status;
    const receivedStatus=typeof data.status==='string'?data.status:typeof record(data.result).status==='string'?String(record(data.result).status):event.type==='tool.completed'&&!previousStatus?'completed':undefined;
    tool.status = mergeToolStatus(previousStatus, receivedStatus);
    if (data.result && typeof data.result === 'object') tool.result = mergeToolResult(previous, data.result as ToolActivity['result'], {snapshot:event.type==='process.updated'});
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
    value.status = mergeToolStatus(value.status, approval.status === 'pending' ? 'pending_approval' : ['approved', 'executing'].includes(approval.status) ? 'running' : approval.status);
    value.returned = !['pending', 'approved', 'executing'].includes(approval.status);
    if (approval.result) value.result = mergeToolResult(value.result, approval.result);
    aliases.set(key, value);
  }
  return [...new Set(aliases.values())].filter(tool=>!['spawn_subagent','create_bot','send_subagent_message','send_to_bot'].includes(tool.name) || tool.name!=='send_subagent_message'&&['failed','interrupted','cancelled'].includes(tool.result?.status||tool.status||'') || ![...tool.aliases].some(alias=>collaborationIdentities.has(alias))).map(tool => {
    const process = tool.process || indexes.processes.get(tool.result?.processId || displayText(tool.data.operationId));
    if (!process) return tool;
    // Process observations outlive the original tool/approval receipt. Keep the
    // original operation and timeline position while applying the latest state.
    const originalExec = tool.name === 'exec' || Boolean(tool.process);
    const result=mergeToolResult(tool.result,record(process.data.result),{snapshot:true});
    return {...tool, process, name: originalExec ? 'exec' : tool.name, result, data: originalExec ? {...tool.data, ...process.data, input: {...toolInput(tool), ...record(process.data.input)},result} : {...tool.data, result, cancellationRequested: process.data.cancellationRequested}};
  });
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

const ToolActivityRow = memo(function ToolActivityRow({tool, run, botId, panel = false}: {tool: ToolActivity; run?: ChatModel['runs'][number]; botId: string; panel?: boolean}) {
  const [expanded, setExpanded] = useState(false), [detail, setDetail] = useState<'output'|'command'|'details'|null>(null);
  const state = toolActivityState(tool, run), presentation = toolPresentation(tool), input = toolInput(tool);
  const command = presentation.command ? displayText(input.command) : '';
  const identity = activityIdentity(tool.name, command), Icon = identity.Icon;
  const StatusIcon = state.running ? LoaderCircleIcon : state.cancelled ? SquareIcon : state.failed || state.unknown ? CircleAlertIcon : state.pending ? ShieldCheckIcon : CheckIcon;
  const output = typeof tool.result?.output === 'string' ? tool.result.output : '';
  const error = toolFailureSummary(tool.result, state);
  const diagnosticClass = tool.result?.status === 'completed' ? 'timber-save-warning' : state.failed ? 'timber-inline-error' : '';
  const gui = /^(?:desktop_)?(?:click|move|double_click|doubleClick|drag|type|key|scroll|navigate)$/.test(tool.name) || tool.name === 'browser_navigate';
  const redundant = gui && tool.result?.status === 'completed' && /^(?:click|move|doubleClick|drag|type|key|scroll|navigate) submitted to desktop\.?$/i.test(output.trim());
  const format = useMemo(()=>outputFormat(output, tool.name, {path: input.path}), [output, tool.name, input.path]);
  const preview = error || (tool.name === 'exec' && state.status === 'completed' && !output.trim() ? 'No output' : '');
  const showOutput = Boolean(output.trim()) && !redundant && output.trim() !== preview.trim();
  const operation = String(tool.data.operationId || tool.data.toolCallId || tool.key);
  const attributes = panel ? {'data-activity-tool-operation-id': operation} : {'data-tool-operation-id': operation};
  const statusLabel = `${state.text}${tool.result?.exitCode !== undefined ? ` · exit ${tool.result.exitCode}` : ''}`;
  const tabs = [...(output ? ['output' as const] : []), ...(command ? ['command' as const] : []), 'details' as const];
  const selected = detail && tabs.includes(detail) ? detail : tabs[0];
  return <details className={`timber-tool-row${state.failed ? ' timber-tool-error' : ''}`} {...attributes} data-process-id={tool.result?.processId} data-tool-status={state.status} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary className="timber-tool-summary" title="Show full output and details">
      <span className="timber-tool-kind" title={identity.label} aria-label={identity.label}><Icon aria-hidden="true"/></span>
      <div className="timber-tool-overview">
        <div className={`timber-tool-command${presentation.command ? ' is-command' : ''}`}>{command ? <ActivityCode code={command} language="bash" compact/> : presentation.title}</div>
        <div className="timber-tool-meta"><span className={state.pending || state.cancelled || state.unknown ? 'timber-tool-parameters' : 'timber-sr-only'}>{statusLabel}</span>{tool.result?.exitCode !== undefined && tool.result.exitCode !== 0 && !state.cancelled && <span className="timber-tool-exit">exit {tool.result.exitCode}</span>}{presentation.parameters && <span className="timber-tool-parameters">{presentation.parameters}</span>}{tool.result?.checkpointStatus==='pending' && <span className="timber-tool-parameters" data-checkpoint-status="pending">Saving files…</span>}</div>
        {(preview || showOutput) && <div className="timber-tool-preview" data-tool-result-preview>{preview && <div className={`timber-tool-preview${error && diagnosticClass ? ` ${diagnosticClass}` : ''}`}>{bounded(preview,420)}</div>}{showOutput && <ActivityOutput format={format} compact/>}</div>}
        {tool.result?.artifactId && <ArtifactPreview key={`${botId}:${tool.result.artifactId}`} botId={botId} artifactId={tool.result.artifactId}/>}
      </div>
      <span className="timber-tool-corner"><span className="timber-tool-status" role="status" aria-label={statusLabel} title={statusLabel}><StatusIcon className={state.running ? 'timber-spinner' : ''} aria-hidden="true"/></span><ChevronDownIcon className="timber-tool-chevron" aria-hidden="true"/></span>
    </summary>
    {expanded && <div className="timber-tool-expanded">
      <div className="timber-tool-tabs" role="group" aria-label="Action detail">{tabs.map(tab=><button type="button" key={tab} aria-pressed={selected===tab} onClick={()=>setDetail(tab)}>{tab==='details' ? 'Details' : tab==='command' ? 'Command' : 'Output'}</button>)}</div>
      {selected === 'output' && <div className="timber-tool-output"><ActivityOutput format={format} source={output}/></div>}
      {selected === 'command' && <ActivityCode code={command} language="bash"/>}
      {selected === 'details' && <div className="timber-tool-data"><ActivityCode code={safeJSON(publicToolData(tool))} language="json"/></div>}
      {error && <p className={diagnosticClass}>{error}</p>}
    </div>}
  </details>;
}, (previous, next) => previous.botId === next.botId && previous.panel === next.panel && previous.run === next.run && sameValue(previous.tool, next.tool));

const ActivityGroup = memo(function ActivityGroup({botId, run, runId, steps, latest, retry}: {botId:string; run?:ChatModel['runs'][number]; runId?: string; steps: ActivityStep[]; latest: boolean; retry?:string|null}) {
  const working = steps.some(step => toolActivityState(step.tool, run).running) || latest && run?.status === 'running';
  return <section className="timber-activity-group" data-run-activity={runId || 'unassigned'} aria-label="Activity">
    <div className="timber-activity-header"><ActivityIcon aria-hidden="true" /><span>Activity</span><span className="timber-activity-count">{steps.length} {steps.length === 1 ? 'action' : 'actions'}</span>{working && <span className="timber-activity-status" role="status"><LoaderCircleIcon className="timber-spinner" aria-hidden="true" />{retry || 'Working'}</span>}</div>
    <div className="timber-activity-content">{steps.map(step => <ToolActivityRow key={step.key} tool={step.tool} run={run} botId={botId} />)}</div>
  </section>;
}, (previous, next) => previous.botId === next.botId && previous.run === next.run && previous.latest === next.latest && previous.retry === next.retry && sameValue(previous.steps, next.steps));

function ActivityPanel({model,callbacks}: {model: ActivityModel;callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>}) {
  const indexes = useMemo(() => historyIndexes(model), [model]);
  const collaboration = useMemo(() => collectCollaboration(model), [model]);
  const tools = useMemo(() => collectTools(model, true, collaboration, indexes), [model, collaboration, indexes]);
  const entries=[
    ...tools.map(tool=>({key:`tool:${tool.key}`,at:tool.at,running:toolActivityState(tool,indexes.runs.get(tool.runId || '')).running,node:<ToolActivityRow tool={tool} run={indexes.runs.get(tool.runId || '')} botId={model.bot.id} panel/>})),
    ...collaboration.items.map(item=>({key:item.key,at:timestamp(item.createdAt),running:['queued','running','waiting_approval','waiting_connection'].includes(item.notice?.status||item.creation?.status||''),node:<TimelineCollaboration item={item} callbacks={callbacks} context="activity"/>})),
  ].sort((a,b)=>Number(b.running)-Number(a.running)||b.at-a.at);
  return <div className="timber-activity-panel">{entries.length?entries.map(entry=><div key={entry.key}>{entry.node}</div>):<p className="timber-activity-empty">No actions yet.</p>}</div>;
}

// Tool projections are freshly assembled only on a history revision. Compare
// their small structured receipts, never the entire conversation snapshot.
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (left instanceof Set && right instanceof Set) return left.size === right.size && [...left].every(value => right.has(value));
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

const HistoryMessage = memo(function HistoryMessage({message, botId, botName, run, sending, sourceModel, callbacks}: {message:ChatModel['messages'][number];botId:string;botName:string;run?:ChatModel['runs'][number];sending:boolean;sourceModel?:string;callbacks:ChatCallbacks}) {
  if (message.provenance) return <AgentMessageNotice notice={{direction:'from',agent:{id:message.provenance.sourceBotId,name:message.provenance.sourceBotName,kind:'bot',model:sourceModel},text:message.text,messageId:message.id,status:run?.status}} callbacks={callbacks} eventKey={`message:${message.id}`}/>;
  return <Message from={message.role === 'user' ? 'user' : 'assistant'} data-message-id={message.id} data-message-kind={message.kind} data-progress-message-id={message.kind === 'progress' ? message.id : undefined} data-run-id={message.runId} className={`timber-message timber-message-${message.role}`}>
    {message.role !== 'user' && <div className="timber-message-meta"><span>{message.role === 'assistant' ? botName : label(message.role)}</span></div>}
    <MessageContent className="timber-message-content"><Response text={message.text} />{message.attachments?.map(image=><ArtifactPreview key={image.artifactId} botId={botId} artifactId={image.artifactId} compact />)}</MessageContent>
    {['user', 'assistant'].includes(message.role) && <CopyMessage text={message.text} createdAt={message.createdAt} />}
    {message.role === 'user' && <MessageRunStatus run={run} botId={botId} sending={sending} callbacks={callbacks} />}
  </Message>;
});

const TimelineCompaction = memo(function TimelineCompaction({item}: {item:CompactionItem}) {return <CompactionPill item={item}/>;}, (previous, next) => sameValue(previous.item, next.item));

const UnpositionedCompactionHistory = memo(function UnpositionedCompactionHistory({items}: {items:CompactionItem[]}) {
  return items.length ? <section className="timber-compaction-history" data-compaction-unpositioned-group data-timeline-key="unpositioned-compactions" aria-label="Compaction history with unavailable dates"><p className="timber-history-caption">Compaction history · dates unavailable</p>{items.map(item => <TimelineCompaction key={item.key} item={item}/>)}</section> : null;
});

const TimelineCollaboration = memo(function TimelineCollaboration({item, callbacks, context = 'timeline'}: {item:CollaborationItem;callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>;context?:'timeline'|'activity'|'preview'}) {
  return item.notice ? <AgentMessageNotice notice={item.notice} callbacks={callbacks} eventKey={item.key} context={context}/> : item.creation ? <AgentCreationCard creation={item.creation} callbacks={callbacks} context={context === 'preview' ? 'timeline' : context}/> : null;
}, (previous, next) => previous.callbacks === next.callbacks && previous.context === next.context && sameValue(previous.item, next.item));

// All transcript text stays in the DOM: native find, selection, copy and
// assistive technology never depend on a virtual viewport or "load more".
const TimelineHistory = memo(function TimelineHistory({entries}: {entries: TimelineEntry[]}) {
  return <>{entries.map(entry => <div className="timber-timeline-entry" data-timeline-key={entry.key} key={entry.key}>{entry.node}</div>)}</>;
});

function timeline(model: ChatModel, callbacks: ChatCallbacks) {
  const indexes = historyIndexes(model);
  const collaboration = collectCollaboration(model);
  const messages = model.messages.filter(message => !model.runFilter || message.runId === model.runFilter);
  const approvals = model.approvals.filter(approval => !model.runFilter || approval.runId === model.runFilter);
  const pendingApprovals = approvals.filter(approval => ['pending', 'executing', 'approved'].includes(approval.status));
  const current = pendingApprovals.reduce<ChatApproval | undefined>((latest, approval) => !latest || timestamp(approval.createdAt) > timestamp(latest.createdAt) ? approval : latest, undefined);
  const pendingApprovalRuns = new Set(pendingApprovals.map(approval => approval.runId));
  const pendingConnectionRuns = new Set(model.connections.filter(connection => connection.status === 'pending').map(connection => connection.runId));
  // The server run identifies a request even before its transcript row loads.
  // Device clock skew and equal timestamps must never put an effect before it.
  const deliveries = model.deliveries.map(delivery => {
    const run = indexes.operations.get(delivery.operationId);
    return {...delivery, runId: delivery.runId || run?.id, createdAt: run?.createdAt || delivery.createdAt};
  }).filter(delivery => (!model.runFilter || delivery.runId === model.runFilter) &&
    !indexes.requests.has(delivery.runId || ''));
  const requests = new Map<string, {at: number; order: number}>();
  messages.forEach((message, index) => {if (message.role === 'user' && message.runId) requests.set(message.runId, {at: timestamp(message.createdAt), order: index * 2});});
  deliveries.forEach((delivery, index) => {if (delivery.runId) requests.set(delivery.runId, {at: timestamp(delivery.createdAt), order: (messages.length + index) * 2});});
  const messagePosition = (message: ChatModel['messages'][number], index: number) => {
    const request = message.role === 'assistant' && message.runId ? requests.get(message.runId) : undefined;
    const at = Math.max(timestamp(message.createdAt), request?.at || 0);
    return {at, order: Math.max(index * 2, request && request.at === at ? request.order + 2 : 0)};
  };
  const assistantPositions = new Map<string, {introduction?:number;answer?:number}>();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.runId) return;
    const position = messagePosition(message, index), key = `${message.runId}:${position.at}`;
    const tied = assistantPositions.get(key) || {};
    if (message.kind === 'progress') tied.introduction = Math.max(tied.introduction ?? -Infinity, position.order);
    else tied.answer = Math.min(tied.answer ?? Infinity, position.order);
    assistantPositions.set(key, tied);
  });
  const afterRequest = (runId: string | undefined, createdAt: number) => {
    const request = runId ? requests.get(runId) : undefined;
    const at = Math.max(createdAt, request?.at || 0);
    // Tool-calling commentary introduces its actions, even if the clocks tie.
    // Final answers keep their transcript position after those actions.
    const tied = runId ? assistantPositions.get(`${runId}:${at}`) : undefined;
    const order = tied?.introduction !== undefined ? tied.introduction + 1
      : tied?.answer !== undefined ? tied.answer - 1
      : request && request.at === at ? request.order + 1 : (messages.length + deliveries.length) * 2 + 1;
    return {at, order};
  };
  const entries: TimelineEntry[] = [];
  messages.forEach((message, index) => {
    const run = indexes.runs.get(message.runId || '');
    entries.push({key: `message:${message.id}`, ...messagePosition(message,index), node: <HistoryMessage message={message} botId={model.bot.id} botName={model.bot.name} run={(message.role === 'user' && run?.status === 'queued') || message.provenance ? run : undefined} sending={message.role === 'user' && run?.status === 'queued' && Boolean(run.error) ? model.sending : false} sourceModel={message.provenance ? indexes.bots.get(message.provenance.sourceBotId)?.model : undefined} callbacks={callbacks}/>});
  });
  for (const approval of approvals) entries.push({key: `approval:${approval.id}`, ...afterRequest(approval.runId, timestamp(approval.createdAt)), node: <ApprovalEntry approval={approval} process={indexes.processes.get(approval.result?.processId || approval.operationId)} agentName={indexes.agents.get(indexes.runs.get(approval.runId)?.subagentId || '')?.name} current={approval.id === current?.id} automatic={model.bot.computerApprovalMode === 'automatic'} callbacks={callbacks} />});
  for (const connection of model.connections.filter(item => !model.runFilter || item.runId === model.runFilter)) {
    entries.push({key: `connection:${connection.id}`, ...afterRequest(connection.runId, timestamp(connection.createdAt)), node: <ConnectionEntry connection={connection} callbacks={callbacks} />});
  }
  deliveries.forEach((delivery, index) => entries.push({key: `delivery:${delivery.operationId}`, at: timestamp(delivery.createdAt), order: (messages.length + index) * 2, node: <DeliveryEntry delivery={delivery} busy={model.sending} callbacks={callbacks} />}));
  for(const item of collaboration.items)entries.push({key:`collaboration:${item.key}`,...afterRequest(item.runId,timestamp(item.createdAt)),node:<TimelineCollaboration item={item} callbacks={callbacks}/>});
  const compactions = collectCompactions(model), unpositionedCompactions = compactions.filter(item => item.unpositioned);
  for (const item of compactions) if (!item.unpositioned) entries.push({key:item.key,...afterRequest(item.runId,timestamp(item.createdAt)),node:<TimelineCompaction item={item}/>});
  const tools = collectTools(model, false, collaboration, indexes);
  const toolRuns = new Set(tools.map(tool => tool.runId));
  for (const tool of tools) {
    entries.push({key:`activity:${tool.key}`, ...afterRequest(tool.runId,tool.at), node:null, tool});
  }
  const active = model.runs.some(run => !run.subagentId && !terminal.has(run.status));
  for (const outcome of runOutcomes(model.runs, model.events, model.runFilter)) {
    const {run} = outcome;
    const at = Math.max(requests.get(run.id)?.at || 0, timestamp(run.updatedAt), timestamp(outcome.createdAt), indexes.latestAt.get(run.id) || 0);
    entries.push({key:`outcome:${outcome.key}`,at,order:(messages.length + deliveries.length)*2+4,node:<TaskOutcome botId={model.bot.id} run={run} request={indexes.requests.get(run.id)} failure={failureRecovery(run, indexes.eventsByRun.get(run.id) || [])} sending={model.sending} active={active} kind={outcome.kind} cancellationId={outcome.cancellationId} callbacks={callbacks}/>});
  }
  // Group only adjacent actions after ordering the complete conversation.
  // A single run can contain several replies; later actions must not be moved
  // into an earlier block above the reply that introduced them.
  const sorted = entries.sort((a,b)=>a.at-b.at || a.order-b.order);
  const lastTool = new Map(sorted.flatMap(entry=>entry.tool ? [[entry.tool.runId,entry.tool.key] as const] : []));
  const ordered: TimelineEntry[] = [];
  let group: {entry: TimelineEntry; runId?: string; steps: ActivityStep[]} | undefined;
  const flush = () => {
    if (!group) return;
    const {entry,runId,steps} = group;
    ordered.push({...entry,node:<ActivityGroup botId={model.bot.id} run={indexes.runs.get(runId || '')} retry={indexes.retries.get(runId)} runId={runId} steps={steps} latest={steps.some(step=>step.key===lastTool.get(runId))}/>});
    group = undefined;
  };
  for (const entry of sorted) {
    if (!entry.tool) {flush();ordered.push(entry);continue;}
    if (group && group.runId !== entry.tool.runId) flush();
    group ||= {entry,runId:entry.tool.runId,steps:[]};
    group.steps.push({tool:entry.tool,key:entry.tool.key,at:entry.at});
  }
  flush();
  return {entries: ordered, unpositionedCompactions, indexes, toolRuns, pendingApprovalRuns, pendingConnectionRuns};
}

function ConversationBody({ model, callbacks }: { model: ChatModel; callbacks: ChatCallbacks }) {
  const { scrollRef, scrollToBottom } = useConversationContext();
  const focus = useRef(model.focusApproval);
  const sending = useRef(new Set<string>());
  useLayoutEffect(() => {
    const next = new Set(model.deliveries.filter(delivery => delivery.state === 'sending').map(delivery => delivery.operationId));
    // A local send follows immediately, including when reading history. An
    // acknowledgement must not pull back someone who has since scrolled away.
    if ([...next].some(id => !sending.current.has(id))) scrollToBottom();
    sending.current = next;
  }, [model.deliveries, scrollToBottom]);
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
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || model.runFilter || !model.historyHasMore || !callbacks.onHistoryNearTop) return;
    const nearTop = () => {if (node.scrollTop <= Math.max(600, node.clientHeight * 2)) callbacks.onHistoryNearTop?.(model.bot.id);};
    // Background archive loading normally has the page ready already; this
    // also resumes after a transient failure without a user-facing load button.
    node.addEventListener('scroll', nearTop, {passive:true});
    nearTop();
    return () => node.removeEventListener('scroll', nearTop);
  }, [model.bot.id, model.runFilter, model.historyHasMore, model.historyLoading, model.historyError, callbacks, scrollRef]);
  // Drafts and response chunks never invalidate the completed history. The
  // transport supplies immutable, referentially stable collection revisions.
  const {entries, unpositionedCompactions, indexes, toolRuns, pendingApprovalRuns, pendingConnectionRuns} = useMemo(() => timeline(model, callbacks), [model.bot.id, model.bot.name, model.bot.model, model.bot.computerApprovalMode, model.messages, model.runs, model.approvals, model.connections, model.events, model.deliveries, model.subagents, model.delegations, model.mentionBots, model.collaborationEvents, model.compactions, model.runFilter, model.sending, callbacks]);
  const visibleRun = model.currentRun && (!model.runFilter || model.runFilter === model.currentRun.id) ? model.currentRun : null;
  const hasInlineStatus = visibleRun && (
    pendingApprovalRuns.has(visibleRun.id) ||
    pendingConnectionRuns.has(visibleRun.id) ||
    (visibleRun.status === 'queued' && indexes.requests.has(visibleRun.id)) ||
    (visibleRun.status === 'running' && toolRuns.has(visibleRun.id))
  );
  return <>
    <ConversationContent className="timber-conversation-content">
      {!model.runFilter && (model.historyLoading || model.historyError) && <p className={`timber-history-caption${model.historyError ? ' timber-inline-error' : ''}`} data-conversation-history-status role="status">{model.historyError ? 'Reconnecting to older conversation history…' : 'Loading earlier conversation…'}</p>}
      {!entries.length && !unpositionedCompactions.length && <ConversationEmptyState className="timber-chat-empty" title={model.loading ? 'Loading…' : `Ask ${model.bot.name}`} description="" />}
      <UnpositionedCompactionHistory items={unpositionedCompactions}/>
      <TimelineHistory entries={entries}/>
      {model.feedback && (!model.runFilter || model.feedback.runId === model.runFilter) && <div id="approval-feedback" role="status" className={model.feedback.error ? 'timber-feedback timber-inline-error' : 'timber-feedback'}>{model.feedback.text}</div>}
      {model.stream && <Message from="assistant" id="streaming-message" className="timber-message" data-run-id={model.stream.runId}>
        <div className="timber-message-meta"><span>{model.bot.name}</span><span className="timber-responding"><LoaderCircleIcon className="timber-spinner" /> Responding</span></div>
        <MessageContent className="timber-message-content"><div id="streaming-text"><Response text={model.stream.text} streaming /></div></MessageContent>
        <CopyMessage text={model.stream.text} kind="streaming" />
      </Message>}
      {!model.stream && visibleRun && !terminal.has(visibleRun.status) && !hasInlineStatus && <div className="timber-work-status" role="status">
        {visibleRun.status === 'waiting_connection' ? <GitBranchIcon /> : visibleRun.status === 'waiting_approval' ? <ShieldCheckIcon /> : visibleRun.status === 'queued' ? <ClockIcon /> : <LoaderCircleIcon className="timber-spinner" />}
        <span>{visibleRun.status === 'waiting_connection' ? 'Waiting for GitHub access' : visibleRun.status === 'waiting_approval' ? 'Waiting for your approval' : visibleRun.status === 'queued' ? 'Queued' : indexes.retries.get(visibleRun.id) || `${model.bot.name} is working`}</span>
      </div>}
      {visibleRun?.error && !indexes.requests.has(visibleRun.id) && <div className="timber-delivery-error" role="status"><p>{visibleRun.error}</p>{canRetryAdmission(visibleRun) && <Button variant="outline" size="sm" disabled={model.sending} onClick={() => callbacks.onRetry(model.bot.id, visibleRun.operationId)}>Retry sending</Button>}</div>}
    </ConversationContent>
    <ConversationScrollButton aria-label="Jump to latest message" className="timber-jump-bottom" />
  </>;
}

function ImageControls({sending,hasText,acceptedIds,children}: {sending:boolean;hasText:boolean;acceptedIds?:string[];children:ReactNode}) {
  const attachments=usePromptInputAttachments();
  useEffect(()=>{
    for(const id of acceptedIds??[]) if(attachments.files.some(file=>file.id===id)) attachments.remove(id);
  },[acceptedIds,attachments]);
  const full = attachments.files.length >= 4;
  return <>
    {attachments.files.length > 0 && <div className="timber-image-attachments" aria-label="Attached images">{attachments.files.map(file=><div key={file.id} className="timber-image-attachment">
      <img src={file.url} alt={file.filename || 'Attached image'} />
      <button className="timber-image-remove" type="button" aria-label={`Remove ${file.filename || 'image'}`} title={`Remove ${file.filename || 'image'}`} disabled={sending} onClick={()=>attachments.remove(file.id)}><XIcon aria-hidden="true" /></button>
    </div>)}</div>}
    <div className="timber-composer-row">{children}
      <Button className="timber-attach" type="button" variant="ghost" size="icon" disabled={sending || full} aria-label="Attach images" title={full ? 'Maximum 4 images attached' : 'Attach images · PNG or JPEG, up to 5 MB each'} onClick={()=>attachments.openFileDialog()}><PaperclipIcon aria-hidden="true" /></Button>
      <PromptInputSubmit className="timber-send" aria-label="Send message" title="Send message" disabled={sending || (!hasText && !attachments.files.length)}>{sending ? <LoaderCircleIcon className="timber-spinner" aria-hidden="true" /> : <ArrowUpIcon aria-hidden="true" />}</PromptInputSubmit>
    </div>
    {attachments.files.length > 0 && <div className="timber-attachment-status" role="status">{sending ? 'Sending images…' : `${attachments.files.length} of 4 images · Ready to send`}</div>}
  </>;
}

function Composer({ model, callbacks }: { model: ChatModel; callbacks: ChatCallbacks }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [attachmentError,setAttachmentError]=useState('');
  const pendingCaret = useRef<{text:string;position:number} | null>(null);
  const [caret, setCaret] = useState(model.draft.length), [mentionIndex, setMentionIndex] = useState(0), [dismissed, setDismissed] = useState(false);
  const mentionMatch = /(?:^|\s)@([^\n@]{0,80})$/.exec(model.draft.slice(0, caret));
  const mentionStart = mentionMatch ? caret - mentionMatch[1].length - 1 : -1;
  const choices = !dismissed && mentionMatch ? model.mentionBots.filter(bot => bot.id !== model.bot.id && bot.name.toLocaleLowerCase().includes(mentionMatch[1].toLocaleLowerCase())).slice(0, 8) : [];
  const selectedMentions = model.mentionBots.filter(bot => model.draftMentions.includes(bot.id) && hasBotMention(model.draft, bot.name));
  const mentionName = (bot:ChatModel['bot']) => model.mentionBots.filter(item=>item.name===bot.name).length > 1 ? `${bot.name} · ${bot.id.slice(-8)}` : bot.name;
  const chooseMention = (bot: ChatModel['bot']) => {
    const insertion = `@${bot.name} `, text = model.draft.slice(0, mentionStart) + insertion + model.draft.slice(caret);
    const nextCaret = mentionStart + insertion.length;
    pendingCaret.current = {text,position:nextCaret};
    callbacks.onDraft(model.bot.id, text, [...new Set([...model.draftMentions, bot.id])]);
    setDismissed(true); setCaret(nextCaret);
  };
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending || pending.text !== model.draft) return;
    pendingCaret.current = null;
    // Set the cursor in the same commit as the inserted mention. A deferred
    // frame can arrive after more typing and move the cursor into that text.
    textarea.current?.focus({preventScroll:true});
    textarea.current?.setSelectionRange(pending.position,pending.position);
  },[model.draft]);

  useLayoutEffect(() => {
    // Native sizing avoids briefly collapsing a focused textarea on every key.
    if (CSS.supports('field-sizing', 'content')) return;
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
      {choices.length > 0 && <div className="timber-mention-menu" id="bot-mentions" role="listbox" aria-label="Mention a bot">
        <span className="timber-mention-heading">Send this message to another bot</span>
        {choices.map((bot, index) => <button type="button" key={bot.id} id={`mention-${bot.id}`} role="option" aria-selected={index === Math.min(mentionIndex, choices.length - 1)} data-mention-bot={bot.id} title={bot.model} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(bot)}><span className="timber-mini-avatar timber-model-avatar" data-agent-color={agentColor(bot.id)} aria-hidden="true">{bot.name.slice(0, 1)}<ModelBadge model={bot.model}/></span><span><strong>{mentionName(bot)}</strong><small>{bot.instructions?.split('\n')[0] || 'Named bot'}</small></span></button>)}
      </div>}
      {selectedMentions.length > 0 && <div className="timber-selected-mentions" aria-label="Message recipients">{selectedMentions.map(bot => <span key={bot.id}>To {mentionName(bot)}<button type="button" aria-label={`Remove ${mentionName(bot)} recipient`} onClick={() => callbacks.onDraft(model.bot.id, model.draft, model.draftMentions.filter(id => id !== bot.id))}>×</button></span>)}</div>}
      <div className="timber-composer-controls"><ModelSettings value={model.bot} state={model.modelSettings} disabled={model.sending} onChange={value=>callbacks.onModelSettings(model.bot.id,value)} onRefresh={callbacks.onRefreshModels}/><ContextMemoryControl botId={model.bot.id} request={callbacks.onContextRequest} refreshKey={model.events.at(-1)?.id}/></div>
      <PromptInput id="message-form" className="timber-composer" disabled={model.sending} accept="image/png,image/jpeg" multiple maxFiles={4} maxFileSize={5_000_000} onError={error=>setAttachmentError(error.message)} onReset={event => event.preventDefault()} onSubmit={async ({text,files}) => {
        if(model.sending || (!text.trim() && !files.length)) throw new Error('Not ready');
        if(files.length && selectedMentions.length) {setAttachmentError('Image messages cannot mention other bots yet.');throw new Error('Unsupported recipients');}
        setAttachmentError('');
        try {await callbacks.onSend(model.bot.id,text,selectedMentions.map(bot=>bot.id),files);} catch {setAttachmentError(`${files.length ? 'Images were' : 'Message was'} not delivered. Retry sending to check the same request safely.`);throw new Error('Not delivered');}
      }}>
        <PromptInputBody><ImageControls sending={model.sending} hasText={!!model.draft.trim()} acceptedIds={model.acceptedImageIds}><PromptInputTextarea ref={textarea} id="message" rows={1} aria-label={`Message ${model.bot.name}`} placeholder={`Message ${model.bot.name}`} value={model.draft}
          aria-autocomplete="list" aria-controls={choices.length ? 'bot-mentions' : undefined} aria-expanded={choices.length > 0} aria-activedescendant={choices.length ? `mention-${choices[Math.min(mentionIndex, choices.length - 1)].id}` : undefined}
          onChange={event => {pendingCaret.current=null;setCaret(event.currentTarget.selectionStart);setMentionIndex(0);setDismissed(false);callbacks.onDraft(model.bot.id, event.currentTarget.value);}}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={event => {
            if (!choices.length || event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();setDismissed(true);}
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault();setMentionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);}
            else if (event.key === 'Enter' && !event.shiftKey || event.key === 'Tab') {event.preventDefault();chooseMention(choices[Math.min(mentionIndex, choices.length - 1)]);}
          }} />
          </ImageControls>{attachmentError && <div className="timber-attachment-error" role="alert">{attachmentError}</div>}

        </PromptInputBody>
      </PromptInput>
    </div>;
}

function MiniActivity({model, historyOpen, onHistory, callbacks}: {model: ChatModel; historyOpen: boolean; onHistory(value:boolean): void;callbacks:ChatCallbacks}) {
  const [collapsed,setCollapsed] = useState(false);
  const activityModel = useMemo<ActivityModel>(() => ({...model, runFilter: null}), [model.bot, model.events, model.runs, model.approvals, model.subagents, model.delegations, model.mentionBots, model.messages, model.collaborationEvents]);
  const data = useMemo(() => {
    const indexes = historyIndexes(activityModel), collaboration = collectCollaboration(activityModel);
    const notices = collaboration.items.filter(item => item.notice).sort((a,b) => timestamp(a.createdAt)-timestamp(b.createdAt)).slice(-2);
    const tools = collectTools(activityModel, true, collaboration, indexes).sort((a,b) => b.at-a.at);
    const active = tools.filter(tool => toolActivityState(tool, indexes.runs.get(tool.runId || '')).running);
    const latestRun = model.runs.reduce<ChatModel['runs'][number] | undefined>((latest, run) => !run.subagentId && (!latest || timestamp(run.updatedAt) > timestamp(latest.updatedAt)) ? run : latest, undefined);
    return {indexes, notices, tools, active, latestRun};
  }, [activityModel]);
  const {indexes, notices, tools, active, latestRun} = data;
  const run = model.currentRun;
  const visible = useMemo(() => active.length ? active.slice(0,2) : tools.filter(tool=>!run || tool.runId===run.id).slice(0,1), [active, tools, run?.id]);
  const waiting = run?.status === 'waiting_approval' || run?.status === 'waiting_connection';
  const failed = !run && latestRun && ['failed','interrupted'].includes(latestRun.status);
  const lastReply = useMemo(() => {
    for (let index = model.messages.length - 1; index >= 0; index--) {
      const message = model.messages[index];
      if (message.role === 'assistant' && (!run || message.runId === run.id)) return message;
    }
  }, [model.messages, run?.id]);
  const reply = model.stream?.text || lastReply?.text;
  const delivery = model.deliveries.find(item => ['unknown','rejected'].includes(item.state));
  const heading = delivery ? 'Not delivered' : waiting ? 'Needs attention' : failed ? 'Interrupted' : run || active.length ? indexes.retries.get(run?.id) || (model.stream ? 'Responding' : 'Working') : '';
  const warning = delivery?.error || (failed ? latestRun?.error : '');
  const screenshot = visible.find(tool=>tool.result?.artifactId)?.result?.artifactId;
  return <section className="timber-mini-activity" data-mini-activity aria-label={`${model.bot.name} conversation preview`}>
    <div className="timber-mini-heading">
      <span className="timber-mini-avatar timber-model-avatar" data-agent-color={agentColor(model.bot.id)} title={model.bot.model} aria-hidden="true">{model.bot.name.slice(0,1)}<ModelBadge model={model.bot.model}/></span><strong>{model.bot.name}</strong>
      {heading && <span className={`timber-mini-status${waiting || failed || delivery?' needs-attention':''}`} role="status">{(run || active.length) && !waiting && !failed && !delivery ? <LoaderCircleIcon className="timber-spinner"/> : waiting || failed || delivery ? <CircleAlertIcon/> : null}{heading}</span>}
      <div className="timber-mini-controls">
        <button type="button" data-open-history onClick={()=>{setCollapsed(false);onHistory(!historyOpen);}} aria-expanded={historyOpen} aria-label={historyOpen?'Close conversation history':'Open conversation history'} title={historyOpen?'Close history':'Conversation history'}><HistoryIcon/><span>History</span></button>
        <button type="button" onClick={()=>{if(historyOpen)onHistory(false);setCollapsed(value=>!value);}} aria-expanded={!collapsed} aria-label={collapsed?'Expand chat preview':'Collapse chat preview'} title={collapsed?'Expand preview':'Collapse preview'}>{collapsed?<ChevronUpIcon/>:<ChevronDownIcon/>}</button>
      </div>
    </div>
    {!collapsed && !historyOpen && <div className="timber-mini-body">
      {(model.subagents.length > 0 || model.delegations.length > 0) && <button type="button" className="timber-mini-agents" onClick={() => callbacks.onOpenAgents()}><GitBranchIcon/>View {model.subagents.length + model.delegations.length} agents</button>}
      {(reply || warning || screenshot) && <div className="timber-mini-reply-row">
        <div className={`timber-mini-reply${warning?' timber-inline-error':''}`} data-mini-reply>{warning?<p>{warning}</p>:reply?<Response text={reply} streaming={Boolean(model.stream)}/>:null}</div>
        {screenshot && <ArtifactPreview key={`${model.bot.id}:${screenshot}`} botId={model.bot.id} artifactId={screenshot} compact/>}
      </div>}
      {notices.map(item=><TimelineCollaboration key={item.key} item={item} callbacks={callbacks} context="preview"/>)}
      {visible.map(tool=>{
        const state=toolActivityState(tool,indexes.runs.get(tool.runId || '')),presentation=toolPresentation(tool),identity=activityIdentity(tool.name,presentation.command?displayText(toolInput(tool).command):'');
        const Icon=identity.Icon,StatusIcon=state.running?LoaderCircleIcon:state.cancelled?SquareIcon:state.failed||state.unknown?CircleAlertIcon:state.pending?ShieldCheckIcon:CheckIcon;
        return <div className="timber-mini-step" key={tool.key} title={`${presentation.title} · ${state.text}`}><Icon aria-hidden="true"/><span className={presentation.command?'is-command':''}>{presentation.title}</span><span className="timber-mini-step-status" role="status" aria-label={state.text}><StatusIcon className={state.running?'timber-spinner':''}/><span className="timber-sr-only">{state.text}</span></span></div>;
      })}
    </div>}
  </section>;
}

function ChatAgents({model, callbacks, headerTarget}: {model: ChatModel; callbacks: ChatCallbacks; headerTarget: HTMLElement | null}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const count = model.subagents.length + model.delegations.length;
  useEffect(() => {if (!count) setExpanded(false);}, [count]);
  if (!count || !headerTarget) return null;
  return <>
    {createPortal(<button ref={toggle} type="button" className="timber-chat-agents-toggle" data-chat-agents-toggle aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)} onKeyDown={event => {
      if (event.key === 'Escape' && expanded) {event.preventDefault();event.stopPropagation();setExpanded(false);}
    }}>
      <GitBranchIcon className="timber-chat-agents-icon" aria-hidden="true"/><span>Agents {count}</span><ChevronDownIcon className={expanded ? 'is-expanded' : ''} aria-hidden="true"/>
    </button>, headerTarget)}
    <section id={listId} className="timber-chat-agents" aria-label="Agent collaboration" hidden={!expanded} onKeyDown={event => {
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();setExpanded(false);toggle.current?.focus();}
    }}>
      {expanded && <>
        <div className="timber-chat-agent-list">
          {model.subagents.map(agent => <button type="button" key={agent.id} data-chat-agent={agent.id} onClick={() => callbacks.onOpenAgents(agent.id)}><span className="timber-chat-agent-name">{agent.name}</span><span className="status" data-status={agent.status}>{label(agent.status)}</span></button>)}
          {model.delegations.map(delegation => <button type="button" key={delegation.id} data-chat-delegation={delegation.id} onClick={() => callbacks.onOpenAgents()}><span className="timber-chat-agent-name">{delegation.targetBotName}</span><span className="status" data-status={delegation.status}>{label(delegation.status)}</span></button>)}
        </div>
        <button type="button" className="timber-chat-agent-manage" onClick={() => callbacks.onOpenAgents()}>View all agents<ExternalLinkIcon aria-hidden="true"/></button>
      </>}
    </section>
  </>;
}

function Chat({ model, callbacks, dockTarget, headerTarget }: { model: ChatModel; callbacks: ChatCallbacks; dockTarget: HTMLElement | null; headerTarget: HTMLElement | null }) {
  const [historyOpen,setHistoryOpen] = useState(false);
  useEffect(()=>{if(!dockTarget)setHistoryOpen(false);},[dockTarget]);
  const composer = <Composer model={model} callbacks={callbacks}/>;
  const conversation = <Conversation className="timber-conversation"><ConversationBody model={model} callbacks={callbacks}/></Conversation>;
  return <div className="timber-chat-layout">
    <ChatAgents model={model} callbacks={callbacks} headerTarget={headerTarget}/>
    {model.runFilter && <div id="run-filter" className="timber-filter"><span>Filtered by task</span><Button id="clear-run-filter" variant="ghost" size="sm" onClick={callbacks.onClearFilter}>Show all messages</Button></div>}
    {!(dockTarget && historyOpen) && conversation}
    {dockTarget ? createPortal(<div className="timber-focus-chat"><MiniActivity model={model} historyOpen={historyOpen} onHistory={setHistoryOpen} callbacks={callbacks}/>{historyOpen && <div className="timber-focus-history" aria-label="Conversation history">{conversation}</div>}{composer}</div>,dockTarget) : composer}
  </div>;
}

export function mountChat(element: HTMLElement, callbacks: ChatCallbacks, loadArtifact: ArtifactLoader, headerTarget: HTMLElement | null) {
  const root = createRoot(element);
  let model: ChatModel | null = null, dockTarget: HTMLElement | null = null;
  const render = () => root.render(model ? <ArtifactProvider load={loadArtifact}><Chat key={model.bot.id} model={model} callbacks={callbacks} dockTarget={dockTarget} headerTarget={headerTarget}/></ArtifactProvider> : null);
  return {
    update(value: ChatModel) {model = value; render();},
    setDock(target: HTMLElement | null) {if (dockTarget !== target) {dockTarget = target; render();}},
    clear() {model = null; render();},
  };
}

export function mountToolActivity(element: HTMLElement, loadArtifact: ArtifactLoader, callbacks:Pick<ChatCallbacks,'onOpenBot'|'onOpenAgents'>) {
  const root = createRoot(element);
  let model: ActivityModel | null = null, active = false;
  const render = () => root.render(active && model ? <ArtifactProvider load={loadArtifact}><ActivityPanel key={model.bot.id} model={model} callbacks={callbacks}/></ArtifactProvider> : null);
  return {
    // Keep the latest data without duplicating the conversation's code blocks
    // and screenshot previews in a hidden panel.
    update(value: ActivityModel) {if (!sameActivityModel(model, value)) {model = value; if (active) render();}},
    setActive(value: boolean) {if (active !== value) {active = value; render();}},
    clear() {model = null; render();},
  };
}
