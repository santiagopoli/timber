import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpIcon, BotIcon, CheckIcon, CircleAlertIcon, ClockIcon, CopyIcon, LoaderCircleIcon, ShieldCheckIcon, ActivityIcon, WrenchIcon, GitBranchIcon, ExternalLinkIcon } from 'lucide-react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageActions, MessageAction, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought';
import { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest } from '@/components/ai-elements/confirmation';
import { Button } from '@/components/ui/button';
import type { ChatApproval, ChatCallbacks, ChatModel, ChatConnection, MessageDelivery } from './chat-types';
import './chat.css';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const timestamp = (value?: string) => value ? Date.parse(value) || 0 : 0;
const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const label = (value: string) => value.replaceAll('_', ' ');
const safeJSON = (value: unknown): string => JSON.stringify(value, (key, item) => /token|secret|password|authorization|credential/i.test(key) ? '[hidden]' : item, 2);
const actionText = (approval: ChatApproval) => approval.action.type === 'type' ? 'Type text · input hidden' : approval.action.type === 'exec' ? approval.action.command : safeJSON(approval.action);
const responseComponents = { img: () => null };

function Response({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MessageResponse className="timber-markdown" mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} parseIncompleteMarkdown skipHtml plugins={{}} components={responseComponents} controls={false}>{text}</MessageResponse>;
}

function CopyMessage({ text, kind = 'message' }: { text: string; kind?: 'message' | 'pending' | 'streaming' }) {
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
    <span className={state === 'failed' ? 'timber-copy-feedback timber-copy-error' : 'timber-copy-feedback'} role="status">{state === 'copied' ? kind === 'streaming' ? 'Response so far copied' : 'Copied' : state === 'failed' ? 'Copy failed. Select the message and copy it manually.' : ''}</span>
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
        <ConfirmationRequest><p className="timber-approval-help">Review this exact action before it runs on your bot’s computer.</p></ConfirmationRequest>
        <ConfirmationActions className="timber-approval-actions">
          <ConfirmationAction disabled={approval.busy} variant="outline" data-approval-decision="deny" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'deny')}>Deny</ConfirmationAction>
          <ConfirmationAction disabled={approval.busy} data-approval-decision="approve" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve')}>{approval.busy ? 'Working…' : 'Approve'}</ConfirmationAction>
          {!automatic && <ConfirmationAction disabled={approval.busy} variant="secondary" className="timber-approve-allow" data-approval-decision="approve-and-allow" onClick={() => callbacks.onDecision(approval.botId, approval.id, 'approve', true)}>Approve and allow computer use</ConfirmationAction>}
        </ConfirmationActions>
        {!automatic && <p className="timber-approval-help">“Approve and allow” also authorizes future commands, file changes and desktop actions for this bot.</p>}
      </Confirmation>}
      {executing && <p className="timber-approval-help"><LoaderCircleIcon className="timber-spinner" aria-hidden="true" /> Approved action is executing. Its result will appear here.</p>}
      {approval.status === 'expired' && <p className="timber-approval-help">This request expired and can no longer be approved.</p>}
      {approval.result?.error && <p className="timber-inline-error">{approval.result.error}</p>}
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
  if (!run || (terminal.has(run.status) && !['cancelled', 'interrupted'].includes(run.status) && !run.error)) return null;
  return <div className="timber-message-run" data-message-run-status={run.status}>
    <span className="timber-delivery-status">{['cancelled', 'interrupted'].includes(run.status) ? <CircleAlertIcon /> : run.status === 'queued' ? <ClockIcon /> : run.status === 'waiting_approval' ? <ShieldCheckIcon /> : <CheckIcon />}{label(run.status).replace(/^./, character => character.toUpperCase())}</span>
    {['cancelled', 'interrupted'].includes(run.status) && <p className="timber-receipt-help">This run stopped. Review any completed actions before starting another task.</p>}
    {run.status === 'queued' && !run.error && <p className="timber-receipt-help">Accepted · waiting for its turn</p>}
    {run.error && <div className="timber-delivery-error"><p>{run.error}</p>{run.status === 'queued' && run.error.includes('Retry this message') && <Button variant="outline" size="sm" disabled={model.sending} onClick={() => callbacks.onRetry(model.bot.id, run.operationId)}>Retry sending</Button>}</div>}
  </div>;
}

function ConnectionEntry({ connection, callbacks }: { connection: ChatConnection; callbacks: ChatCallbacks }) {
  const pending = connection.status === 'pending';
  return <article className="timber-connection-entry" data-connection-id={connection.id} data-connection-status={connection.status} data-run-id={connection.runId}>
    <div className="timber-connection-heading"><GitBranchIcon aria-hidden="true" /><strong>{pending ? 'Connect GitHub to continue' : connection.status === 'connected' ? 'GitHub access connected' : 'GitHub request cancelled'}</strong><time>{time(connection.createdAt)}</time></div>
    <p className="timber-connection-repository">{connection.repository}</p>
    <p className="timber-connection-scope">{connection.permission === 'write' ? 'Read this repository, push branches, and create pull requests.' : 'Read and clone this repository.'}</p>
    {pending && <>
      <Button disabled={connection.busy} data-connect-github onClick={() => callbacks.onConnect(connection.botId, connection.id)}>{connection.busy ? <LoaderCircleIcon className="timber-spinner" /> : <ExternalLinkIcon />}{connection.busy ? 'Opening GitHub…' : connection.opened ? 'Continue in GitHub' : 'Connect GitHub'}</Button>
      <p className="timber-approval-help">{connection.opened ? 'Finish connecting in the new tab. This task will continue automatically.' : 'Choose the repository in GitHub. This task will continue when access is connected.'}</p>
    </>}
    {connection.status === 'connected' && <p className="timber-approval-help"><CheckIcon />Access was connected for this task.</p>}
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
    {delivery.state === 'accepted' && <p className="timber-receipt-help">Accepted by {delivery.botId ? 'your bot' : 'Timber'}. {delivery.runStatus === 'queued' ? 'Waiting to start; it will run after the current task.' : 'Conversation history is syncing.'}</p>}
    {delivery.error && <div className="timber-delivery-error"><p>{delivery.error}</p>{delivery.canRetry && <Button variant="outline" size="sm" disabled={busy} onClick={() => callbacks.onRetry(delivery.botId, delivery.operationId)}>Retry sending</Button>}</div>}
  </Message>;
}

type TimelineEntry = { key: string; at: number; order: number; node: ReactNode };
type ToolActivity = { key: string; runId?: string; at: number; name: string; aliases: Set<string>; returned: boolean; status?: string; result?: {status?: string; output?: string; error?: string; exitCode?: number}; data: Record<string, unknown> };
type ActivityStep = {at: number; key: string} & ({type: 'progress'; message: ChatModel['messages'][number]} | {type: 'tool'; tool: ToolActivity});
const toolNames: Record<string, string> = {exec: 'Command', read_file: 'Read file', readFile: 'Read file', write_file: 'Write file', writeFile: 'Write file', list_files: 'Browse files', listFiles: 'Browse files', desktop_screenshot: 'Screenshot', screenshot: 'Screenshot', browser_navigate: 'Open page', navigate: 'Open page', desktop_click: 'Click', desktop_type: 'Type', desktop_key: 'Press key', desktop_scroll: 'Scroll', checkpoint: 'Save checkpoint'};

function collectTools(model: ChatModel): ToolActivity[] {
  // A host event bridges the native call ID and the durable computer operation ID.
  // Merge those explicit aliases only: identical command text is not identity.
  const aliases = new Map<string, ToolActivity>();
  for (const event of model.events) {
    if (model.runFilter && event.runId !== model.runFilter) continue;
    const data = event.data, ids = [data.operationId, data.toolCallId].filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (!ids.length) continue;
    const keys = ids.map(id => `${event.runId || ''}:${id}`), matches = [...new Set(keys.map(key => aliases.get(key)).filter((tool): tool is ToolActivity => Boolean(tool)))];
    const tool = matches[0] || {key: keys[0], runId: event.runId, at: timestamp(event.createdAt), name: 'Computer tool', aliases: new Set<string>(), returned: false, data: {}};
    for (const merged of matches.slice(1)) {
      tool.at = Math.min(tool.at, merged.at); tool.returned ||= merged.returned;
      if (!tool.result && merged.result) tool.result = merged.result;
      if (!tool.status && merged.status) tool.status = merged.status;
      for (const alias of merged.aliases) {tool.aliases.add(alias); aliases.set(alias, tool);}
    }
    for (const key of keys) {tool.aliases.add(key); aliases.set(key, tool);}
    if (typeof data.actionType === 'string') tool.name = data.actionType;
    else if (typeof data.toolName === 'string' && tool.name === 'Computer tool') tool.name = data.toolName;
    tool.returned ||= event.type === 'tool.completed';
    if (typeof data.status === 'string') tool.status = data.status;
    if (data.result && typeof data.result === 'object') tool.result = data.result as ToolActivity['result'];
    tool.data = {...tool.data, ...data};
  }
  return [...new Set(aliases.values())].filter(tool => !model.approvals.some(approval => tool.aliases.has(`${approval.runId}:${approval.operationId}`)));
}

function ActivityGroup({model, runId, steps}: {model: ChatModel; runId?: string; steps: ActivityStep[]}) {
  const run = model.runs.find(item => item.id === runId), active = Boolean(run && !terminal.has(run.status));
  const [open, setOpen] = useState(active), manuallyToggled = useRef(false);
  useEffect(() => {if (!manuallyToggled.current) setOpen(active);}, [active]);
  const tools = steps.filter(step => step.type === 'tool').length;
  return <ChainOfThought className="timber-activity-group" data-run-activity={runId || 'unassigned'} open={open} onOpenChange={value => {manuallyToggled.current = true; setOpen(value);}}>
    <ChainOfThoughtHeader className="timber-activity-header"><span className="timber-activity-title"><ActivityIcon aria-hidden="true" /> Activity <span>{tools ? `${tools} ${tools === 1 ? 'action' : 'actions'}` : 'Updates'}</span>{run && <span className="timber-activity-status" data-status={run.status}>{label(run.status)}</span>}</span></ChainOfThoughtHeader>
    <ChainOfThoughtContent className="timber-activity-content">
      {steps.sort((a, b) => a.at - b.at).map(step => {
        if (step.type === 'progress') return <ChainOfThoughtStep key={step.key} icon={BotIcon} label={<span className="timber-activity-label">{model.bot.name}<time>{time(step.message.createdAt)}</time></span>} status="complete" data-message-id={step.message.id} data-message-kind="progress" data-progress-message-id={step.message.id} className="timber-progress-step"><Response text={step.message.text} /><CopyMessage text={step.message.text} /></ChainOfThoughtStep>;
        const tool = step.tool, status = tool.result?.status || tool.status;
        const failed = status === 'failed' || status === 'interrupted', pending = status === 'pending_approval' || status === 'pending_connection';
        const waiting = !tool.returned && !status, unknown = waiting && !active;
        const state = failed ? label(status!) : status === 'pending_connection' ? 'Connection requested' : pending ? 'Approval requested' : status === 'completed' ? 'Completed' : unknown ? 'Outcome unconfirmed' : waiting ? 'Running' : 'Tool returned';
        return <ChainOfThoughtStep key={step.key} data-tool-operation-id={String(tool.data.operationId || tool.data.toolCallId)} data-tool-status={status || (unknown ? 'unconfirmed' : waiting ? 'running' : 'returned')} icon={failed || unknown ? CircleAlertIcon : pending ? ShieldCheckIcon : waiting ? LoaderCircleIcon : CheckIcon} status={waiting && active ? 'active' : 'complete'} className={`timber-tool-step${failed || unknown ? ' timber-tool-error' : ''}`} label={<span className="timber-activity-label">{toolNames[tool.name] || label(tool.name)}<span className="timber-tool-status">{state}{tool.result?.exitCode !== undefined ? ` · exit ${tool.result.exitCode}` : ''}</span></span>}>
          {tool.result?.error && <p className="timber-inline-error">{tool.result.error}</p>}
          <details className="timber-tool-details"><summary>Details{tool.result?.output ? ' & output' : ''}</summary>{tool.result?.output && <pre className="timber-action"><code>{tool.result.output}</code></pre>}<pre className="timber-action"><code>{safeJSON(tool.data)}</code></pre></details>
        </ChainOfThoughtStep>;
      })}
    </ChainOfThoughtContent>
  </ChainOfThought>;
}

function timeline(model: ChatModel, callbacks: ChatCallbacks): TimelineEntry[] {
  const messages = model.messages.filter(message => !model.runFilter || message.runId === model.runFilter);
  const approvals = model.approvals.filter(approval => !model.runFilter || approval.runId === model.runFilter);
  const current = [...approvals].filter(approval => ['pending', 'executing', 'approved'].includes(approval.status)).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))[0];
  const entries: TimelineEntry[] = [], groups = new Map<string, {runId?: string; steps: ActivityStep[]}>();
  const addActivity = (runId: string | undefined, step: ActivityStep) => {const key = runId || step.key, group = groups.get(key) || {runId, steps: []}; group.steps.push(step); groups.set(key, group);};
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.kind === 'progress') {addActivity(message.runId, {type: 'progress', message, key: message.id, at: timestamp(message.createdAt)}); return;}
    entries.push({key: `message:${message.id}`, at: timestamp(message.createdAt), order: index * 2, node: <Message from={message.role === 'user' ? 'user' : 'assistant'} data-message-id={message.id} data-run-id={message.runId} className={`timber-message timber-message-${message.role}`}>
      <div className="timber-message-meta"><span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? model.bot.name : label(message.role)}</span><time>{time(message.createdAt)}</time></div>
      <MessageContent className="timber-message-content"><Response text={message.text} /></MessageContent>
      {['user', 'assistant'].includes(message.role) && <CopyMessage text={message.text} />}
      {message.role === 'user' && <MessageRunStatus model={model} runId={message.runId} callbacks={callbacks} />}
    </Message>});
  });
  const afterRequest = (runId: string | undefined, at: number) => {const index = messages.findIndex(message => message.role === 'user' && message.runId === runId && timestamp(message.createdAt) === at); return index < 0 ? messages.length * 2 + 1 : index * 2 + 1;};
  for (const approval of approvals) entries.push({key: `approval:${approval.id}`, at: timestamp(approval.createdAt), order: afterRequest(approval.runId, timestamp(approval.createdAt)), node: <ApprovalEntry approval={approval} current={approval.id === current?.id} automatic={model.bot.computerApprovalMode === 'automatic'} callbacks={callbacks} />});
  for (const connection of model.connections.filter(item => !model.runFilter || item.runId === model.runFilter)) {
    const request = messages.find(message => message.role === 'user' && message.runId === connection.runId);
    const at = Math.max(timestamp(connection.createdAt), timestamp(request?.createdAt));
    entries.push({key: `connection:${connection.id}`, at, order: afterRequest(connection.runId, at), node: <ConnectionEntry connection={connection} callbacks={callbacks} />});
  }
  for (const delivery of model.deliveries.filter(item => !model.runFilter || item.runId === model.runFilter)) entries.push({key: `delivery:${delivery.operationId}`, at: timestamp(delivery.createdAt), order: messages.length * 2 + 3, node: <DeliveryEntry delivery={delivery} busy={model.sending} callbacks={callbacks} />});
  for (const tool of collectTools(model)) addActivity(tool.runId, {type: 'tool', tool, key: tool.key, at: tool.at});
  for (const [key, group] of groups) {const request = messages.find(message => message.role === 'user' && message.runId === group.runId); const at = Math.max(Math.min(...group.steps.map(step => step.at)), timestamp(request?.createdAt)); entries.push({key: `activity:${key}`, at, order: afterRequest(group.runId, at), node: <ActivityGroup model={model} runId={group.runId} steps={group.steps} />});}
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
  return <>
    <ConversationContent className="timber-conversation-content">
      {!entries.length && <ConversationEmptyState className="timber-chat-empty" icon={<BotIcon size={28} />} title={model.loading ? 'Loading conversation…' : `What should ${model.bot.name} work on?`} description={model.loading ? 'Restoring messages and active tasks.' : 'One bot, one continuous conversation. Give it a task to get started.'} />}
      {entries.map(entry => <div className="timber-timeline-entry" key={entry.key}>{entry.node}</div>)}
      {model.feedback && (!model.runFilter || model.feedback.runId === model.runFilter) && <div id="approval-feedback" role="status" className={model.feedback.error ? 'timber-feedback timber-inline-error' : 'timber-feedback'}>{model.feedback.text}</div>}
      {model.stream && <Message from="assistant" id="streaming-message" className="timber-message" data-run-id={model.stream.runId}>
        <div className="timber-message-meta"><span>{model.bot.name}</span><span className="timber-responding"><LoaderCircleIcon className="timber-spinner" /> Responding</span></div>
        <MessageContent className="timber-message-content"><div id="streaming-text"><Response text={model.stream.text} streaming /></div></MessageContent>
        <CopyMessage text={model.stream.text} kind="streaming" />
      </Message>}
      {!model.stream && visibleRun && !terminal.has(visibleRun.status) && <div className="timber-work-status" role="status">
        {visibleRun.status === 'waiting_connection' ? <GitBranchIcon /> : visibleRun.status === 'waiting_approval' ? <ShieldCheckIcon /> : visibleRun.status === 'queued' ? <ClockIcon /> : <LoaderCircleIcon className="timber-spinner" />}
        <span>{visibleRun.status === 'waiting_connection' ? 'Waiting for GitHub access' : visibleRun.status === 'waiting_approval' ? 'Waiting for your approval' : visibleRun.status === 'queued' ? 'Task queued · waiting to start' : `${model.bot.name} is working`}</span>
      </div>}
      {visibleRun?.error && !model.messages.some(message => message.role === 'user' && message.runId === visibleRun.id) && <div className="timber-delivery-error" role="status"><p>{visibleRun.error}</p>{visibleRun.status === 'queued' && visibleRun.error.includes('Retry this message') && <Button variant="outline" size="sm" disabled={model.sending} onClick={() => callbacks.onRetry(model.bot.id, visibleRun.operationId)}>Retry sending</Button>}</div>}
    </ConversationContent>
    <ConversationScrollButton aria-label="Jump to latest message" className="timber-jump-bottom" />
  </>;
}

function Chat({ model, callbacks }: { model: ChatModel; callbacks: ChatCallbacks }) {
  const active = model.currentRun && !terminal.has(model.currentRun.status);
  return <div className="timber-chat-layout">
    {model.runFilter && <div id="run-filter" className="timber-filter"><span>Showing messages from this run</span><Button id="clear-run-filter" variant="ghost" size="sm" onClick={callbacks.onClearFilter}>Show all messages</Button></div>}
    <Conversation className="timber-conversation" initial="instant" resize="instant"><ConversationBody model={model} callbacks={callbacks} /></Conversation>
    <div className="timber-composer-wrap">
      <PromptInput id="message-form" className="timber-composer" maxFiles={0} onReset={event => event.preventDefault()} onSubmit={({text}) => {if (!model.sending && text.trim()) callbacks.onSend(model.bot.id, text);}}>
        <PromptInputBody><PromptInputTextarea id="message" aria-label={`Message ${model.bot.name}`} placeholder={`Message ${model.bot.name}…`} value={model.draft} onChange={event => callbacks.onDraft(model.bot.id, event.currentTarget.value)} /></PromptInputBody>
        <PromptInputFooter className="timber-composer-footer"><span className="timber-composer-hint">{active ? 'New messages queue as separate tasks' : 'Enter to send · Shift + Enter for a new line'}</span><div className="timber-composer-actions">
          <PromptInputSubmit aria-label="Send message" title="Send message" disabled={model.sending || !model.draft.trim()}>{model.sending ? <LoaderCircleIcon className="timber-spinner" /> : <ArrowUpIcon />}</PromptInputSubmit>
        </div></PromptInputFooter>
      </PromptInput>
      <div className="timber-composer-caption"><ShieldCheckIcon aria-hidden="true" /><span>{model.bot.computerApprovalMode === 'automatic' ? 'Computer use allowed for this bot' : 'Computer actions require your approval'}</span></div>
    </div>
  </div>;
}

export function mountChat(element: HTMLElement, callbacks: ChatCallbacks) {
  const root = createRoot(element);
  return { update(model: ChatModel) {root.render(<Chat key={model.bot.id} model={model} callbacks={callbacks} />);}, clear() {root.render(null);} };
}
