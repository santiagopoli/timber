import { Type } from '@earendil-works/pi-ai';
import {
  configure, defineDoc, defineTask, defineTool, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type AgentEvent, type AgentEventStream, type ConversationId, type Harness, type InboxState,
  type Storage, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type Tx,
} from '@earendil-works/pi-durable';
import type { PiHarness, PiHarnessContext } from 'agents/harness/pi';
import { classifyFailure, normalizeEntries, textContent, toolCompletion } from './normalize.js';
import { computerToolOperationId } from './tools.js';
import type { RuntimeEvent, RuntimePause, RuntimeReceipt, RuntimeSubagent } from './types.js';

type Context = PiHarnessContext['context'];
type StoredAgent = RuntimeSubagent & { conversationId: string; depth: number; spawnOperationId: string };
const Registry = defineDoc<{ agents: Record<string, StoredAgent>; deliveries: Record<string, { text: string; taskId: number }> }>({
  kind: 'timber.subagents', version: 1, scope: 'session', initial: () => ({ agents: {}, deliveries: {} }),
});
const active = new Set<RuntimeSubagent['status']>(['queued', 'running', 'waiting_approval', 'waiting_connection']);
const MAX_AGENTS = 8;
const MAX_DEPTH = 3;
const publicAgent = ({ conversationId: _conversationId, depth: _depth, spawnOperationId: _spawnOperationId, ...agent }: StoredAgent): RuntimeSubagent => agent;
const content = (value: unknown): ToolExecutionResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
async function reportOperationId(subagentId: string, operationId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([subagentId, operationId])));
  return `subagent-report:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface SubagentHost {
  native(): Harness;
  harness(): PiHarness;
  storage(): Storage;
  context(): Context;
  assertActive(): void;
  botName(): Promise<string>;
  emit(event: RuntimeEvent): Promise<void>;
  operationForCall(api: ToolExecutionApi, context: Context): Promise<string>;
  consume(operationId: string, kind: 'generation' | 'tool', itemId: string): void;
  paused(operationId: string): RuntimePause | undefined;
  scheduleWake(): Promise<void>;
  onMessage?(input: { subagentId: string; parentOperationId: string; operationId: string; text: string }): Promise<void>;
}

/** Native Pi conversations and background tasks own execution, inboxes and recovery. */
export function createSubagents(host: SubagentHost) {
  const streams = new Map<string, AgentEventStream>();
  const attaching = new Map<string, Promise<void>>();
  let stopped = false;
  const state = async () => (await host.native().snapshot(Registry, host.context())) ?? { agents: {}, deliveries: {} };
  const find = async (id: string) => {
    const agent = (await state()).agents[id];
    if (!agent) throw new Error('Subagent not found');
    return agent;
  };
  const forConversation = async (id: ConversationId | string) => Object.values((await state()).agents).find(agent => agent.conversationId === String(id));
  const update = async (id: string, patch: Partial<RuntimeSubagent>, operationId?: string) => {
    let changed: StoredAgent | undefined;
    await host.native().commit(async tx => {
      const record = (await tx.doc(Registry)).agents[id];
      if (!record || (operationId && record.operationId !== operationId) || record.status === 'cancelled') return;
      Object.assign(record, patch, { updatedAt: new Date().toISOString() });
      if (patch.status === 'running') { delete record.result; delete record.error; }
      changed = { ...record };
    }, host.context());
    if (changed) await host.emit({ type: 'subagent.updated', operationId: changed.parentOperationId,
      eventKey: `subagent:${id}:${changed.operationId}:${changed.status}`, data: { subagent: publicAgent(changed) } });
  };
  const settle = async (id: string, operationId: string, patch: Partial<RuntimeSubagent>) => {
    let projected: StoredAgent | undefined;
    let next: StoredAgent | undefined;
    await host.native().commit(async tx => {
      const registry = await tx.doc(Registry);
      const record = registry.agents[id];
      if (!record || record.status === 'cancelled') return;
      projected = { ...record, ...patch, operationId, updatedAt: new Date().toISOString() };
      if (patch.result === undefined) delete projected.result;
      if (patch.error === undefined) delete projected.error;
      const current = registry.deliveries[`${id}:${record.operationId}`]?.taskId ?? 0;
      const finished = registry.deliveries[`${id}:${operationId}`]?.taskId ?? 0;
      // Preserve a later active input in the public agent record while still
      // projecting this older input's terminal result to its own host run.
      if (finished >= current) {
        delete record.result;
        delete record.error;
        Object.assign(record, projected);
        // A queued followup keeps the agent's active slot reserved while Pi
        // transitions from the finished input to its next native run.
        if (patch.status !== 'cancelled') {
          const later = Object.entries(registry.deliveries).filter(([key, item]) => key.startsWith(`${id}:`) && item.taskId > finished).sort((left, right) => left[1].taskId - right[1].taskId);
          for (const [key, item] of later) {
            const requestId = key.slice(id.length + 1);
            const submission = await tx.submissionByRequest(Number(record.conversationId) as ConversationId, requestId);
            if (submission?.status === 'done' || submission?.status === 'unanswered') continue;
            if (!submission && (await tx.task(item.taskId as TaskId))?.state.status === 'terminal') continue;
            record.operationId = requestId;
            record.status = submission?.status === 'placed' ? 'running' : 'queued';
            delete record.result;
            delete record.error;
            next = { ...record };
            break;
          }
        }
      }
    }, host.context());
    if (projected) await host.emit({ type: 'subagent.updated', operationId: projected.parentOperationId,
      eventKey: `subagent:${id}:${operationId}:${projected.status}`, data: { subagent: publicAgent(projected) } });
    if (next) await host.emit({ type: 'subagent.updated', operationId: next.parentOperationId,
      eventKey: `subagent:${id}:${next.operationId}:${next.status}`, data: { subagent: publicAgent(next) } });
  };
  const emitMessages = async (id: string, entries: Parameters<typeof normalizeEntries>[0]) => {
    const agent = await find(id);
    for (const message of normalizeEntries(entries)) {
      // Tool messages can include screenshots and host details; tool activity has a reviewed projection.
      if (message.role === 'tool' || message.role === 'system') continue;
      await host.emit({ type: 'subagent.message', operationId: agent.parentOperationId,
        eventKey: `subagent:${id}:${message.id}`, data: { subagentId: id, message } });
    }
  };
  const process = async (id: string, event: AgentEvent) => {
    if (stopped) return;
    const agent = await find(id);
    const emit = (type: string, data: Record<string, unknown>, key?: string) => host.emit({ type: `subagent.${type}`,
      operationId: agent.parentOperationId, ...(key ? { eventKey: `subagent:${id}:${key}` } : {}), data: { subagentId: id, ...data } });
    if (event.type === 'snapshot') {
      await emitMessages(id, event.entries);
      await emit('snapshot', { busy: Boolean(event.run), partialText: textContent(event.generation?.message?.content) });
      // Event projection can be interrupted after native completion. Reconcile
      // every admitted delivery in durable order, including older host runs.
      const deliveries = Object.entries((await state()).deliveries).filter(([key]) => key.startsWith(`${id}:`)).sort((left, right) => left[1].taskId - right[1].taskId);
      for (const [key] of deliveries) {
        const requestId = key.slice(id.length + 1);
        const settled = await host.storage().submissionByRequest(Number(agent.conversationId) as ConversationId, requestId, host.context());
        if (settled && (settled.status === 'done' || settled.status === 'unanswered')) await process(id, { type: 'submission', record: settled });
      }
      const runningInput = event.run?.inputs[0];
      const record = runningInput
        ? await host.storage().submission(runningInput, host.context())
        : await host.storage().submissionByRequest(Number(agent.conversationId) as ConversationId, agent.operationId, host.context());
      if (record) await process(id, { type: 'submission', record });
      return;
    }
    if (event.type === 'message_update') {
      for (const change of event.changes) if (change.type === 'text_delta') await emit('message.delta', { delta: change.delta });
      return;
    }
    if (event.type === 'message_end') {
      await emitMessages(id, [event.entry]);
      for (const message of event.entry.model ?? []) if (message.role === 'toolResult') {
        const result = toolCompletion(event.entry);
        if (!result.operationId && event.entry.byTaskId !== undefined) result.operationId = await computerToolOperationId(String(event.entry.byTaskId), message.toolCallId);
        await emit('tool.completed', { toolCallId: message.toolCallId, toolName: message.toolName, ...result }, `tool:end:${String(event.entry.id)}:${message.toolCallId}`);
      }
      return;
    }
    if (event.type === 'tool_execution_start') {
      await emit('tool.started', { toolCallId: event.toolCallId, toolName: event.toolName }, `tool:start:${agent.operationId}:${event.toolCallId}`);
      return;
    }
    if (event.type === 'submission' && event.record.type === 'input' && event.record.requestId) {
      const record = event.record;
      if (record.status === 'queued' || record.status === 'placed') {
        if (record.status === 'placed') await update(id, { status: 'running', operationId: record.requestId! });
        else await update(id, { status: 'queued' }, record.requestId);
      } else {
        const pending = host.paused(record.requestId!);
        if (pending) await settle(id, record.requestId!, { status: pending.status === 'pending_approval' ? 'waiting_approval' : 'waiting_connection' });
        else if (record.status === 'done') {
          const answer = await host.storage().entry(record.answer, host.context());
          const result = answer ? normalizeEntries([answer.entry]).filter(message => message.role === 'assistant').map(message => message.text).join('\n') : '';
          await settle(id, record.requestId!, { status: 'completed', result });
        } else await settle(id, record.requestId!, { status: record.reason === 'aborted' ? 'cancelled' : 'failed', error: classifyFailure(record.reason, record.detail).publicMessage });
      }
    }
  };
  const attach = (id: string): Promise<void> => {
    if (streams.has(id) || stopped) return Promise.resolve();
    const prior = attaching.get(id);
    if (prior) return prior;
    const promise = (async () => {
      const agent = await find(id);
      const stream = await host.harness().session(agent.conversationId).events();
      if (stopped) { await stream.stop(); return; }
      streams.set(id, stream);
      await process(id, stream.snapshot);
      stream.start(async events => { for (const event of events) await process(id, event); });
    })().finally(() => attaching.delete(id));
    attaching.set(id, promise);
    return promise;
  };
  // The official Pi background-subagent pattern: a native task owns each conversation.
  const Anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'timber.subagent-anchor', version: 1, initial: () => ({ phase: 'done' }),
    phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  type Delivery = { id: string; text: string; operationId: string; notify: boolean };
  type DeliveryState = { phase: 'deliver'; attempt?: number; retryAt?: number } | { phase: 'report'; text?: string; attempt?: number; retryAt?: number };
  const DeliveryTask = defineTask<Delivery, DeliveryState, null>({
    name: 'timber.subagent-delivery', version: 1, initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, context) => {
        host.assertActive();
        if (task.state.checkpoint.retryAt) await runtime.sleep(task.state.checkpoint.retryAt, context);
        const agent = await find(task.input.id);
        if (agent.status === 'cancelled') {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
          return;
        }
        await attach(agent.id);
        await host.emit({ type: 'subagent.updated', operationId: agent.parentOperationId,
          eventKey: `subagent:${agent.id}:${task.input.operationId}:admitted`, data: { subagent: publicAgent(agent) } });
        // PiHarness schedules the durable wake before admission; raw Pi submit would not.
        try {
          const existing = await host.storage().submissionByRequest(Number(agent.conversationId) as ConversationId, task.input.operationId, context);
          if (!existing) await host.harness().session(agent.conversationId).submit(task.input.text, { operationId: task.input.operationId });
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const attempt = (task.state.checkpoint.attempt ?? 0) + 1;
          if (attempt < 5) {
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'deliver', attempt, retryAt: runtime.now() + 1000 * 2 ** (attempt - 1) } }), context);
          } else {
            // Lost receipts are reconciled before giving up. An admitted input
            // is always left to Pi recovery rather than being submitted anew.
            const admitted = await host.storage().submissionByRequest(Number(agent.conversationId) as ConversationId, task.input.operationId, context);
            if (admitted) {
              await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'deliver' } }), context);
            } else {
              await settle(agent.id, task.input.operationId, { status: 'failed', error: 'The subagent input could not be admitted after automatic retries. Send a new message to continue.' });
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
            }
          }
          return;
        }
        const result = await host.harness().session(agent.conversationId).wait(task.input.operationId, context.abortSignal);
        const saved = await host.storage().submissionByRequest(Number(agent.conversationId) as ConversationId, task.input.operationId, context);
        if (saved) await process(agent.id, { type: 'submission', record: saved });
        const pending = host.paused(task.input.operationId);
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'report',
          ...(task.input.notify && !pending && result.status === 'done' && result.text ? { text: result.text } : {}) } }), context);
      },
      report: async (task, runtime, context) => {
        if (task.state.checkpoint.retryAt) await runtime.sleep(task.state.checkpoint.retryAt, context);
        const agent = await find(task.input.id);
        const report = task.state.checkpoint.text;
        if (report && agent.status !== 'cancelled') {
          const text = `Subagent ${agent.name} completed its task:\n${report.length > 31_000 ? `${report.slice(0, 31_000)}\n[The full result is available in the subagent conversation.]` : report}`;
          const operationId = await reportOperationId(agent.id, task.input.operationId);
          try {
            if (agent.parentSubagentId) await send(agent.parentSubagentId, text, { operationId }, false, context);
            else await host.onMessage?.({ subagentId: agent.id, parentOperationId: agent.parentOperationId, operationId, text });
          } catch (error) {
            context.abortSignal?.throwIfAborted();
            const attempt = (task.state.checkpoint.attempt ?? 0) + 1;
            if (attempt < 5) {
              await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'report', text: report, attempt, retryAt: runtime.now() + 1000 * 2 ** (attempt - 1) } }), context);
              return;
            }
            await host.emit({ type: 'subagent.report_failed', operationId: agent.parentOperationId,
              eventKey: `subagent:report-failed:${operationId}`, data: { subagentId: agent.id, errorCode: 'subagent_report_failed', message: 'The result is saved in the subagent conversation but could not be delivered to the parent.' } });
          }
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const delivery = async (tx: Tx, agent: StoredAgent, text: string, operationId: string, notify: boolean) => {
    const registry = await tx.doc(Registry);
    const record = registry.agents[agent.id]!;
    if (!active.has(record.status) && Object.values(registry.agents).filter(agent => active.has(agent.status)).length >= MAX_AGENTS) throw new Error('At most 8 subagents may be active');
    if (!['queued', 'running'].includes(record.status)) {
      record.operationId = operationId;
      record.status = 'queued';
      record.updatedAt = new Date().toISOString();
      delete record.result;
      delete record.error;
    }
    const taskId = await tx.createTask(DeliveryTask, { id: agent.id, text, operationId, notify }, {
      ownership: { kind: 'conversation' }, conversationId: ROOT_CONVERSATION_ID, background: true,
    });
    registry.deliveries[`${agent.id}:${operationId}`] = { text, taskId: Number(taskId) };
  };
  const send = async (id: string, text: string, input: { operationId: string }, notify = true, callContext?: Context): Promise<RuntimeReceipt> => {
    host.assertActive();
    if (!text.trim() || text.length > 32_000 || !/^[A-Za-z0-9:_.-]{1,160}$/.test(input.operationId)) throw new Error('Invalid subagent message');
    // A host message may arrive after the root session's last wake finished.
    // Persist a wake before the new native delivery task, including the crash gap before admission.
    await host.scheduleWake();
    host.assertActive();
    callContext?.abortSignal?.throwIfAborted();
    let accepted = false;
    await host.native().commit(async tx => {
      const registry = await tx.doc(Registry);
      const record = registry.agents[id];
      if (!record) throw new Error('Subagent not found');
      if (record.status === 'cancelled') throw new Error('Subagent was cancelled');
      const existing = await tx.submissionByRequest(Number(record.conversationId) as ConversationId, input.operationId);
      const previous = registry.deliveries[`${id}:${input.operationId}`];
      if (previous && previous.text !== text) throw new Error('Operation ID already used for another subagent message');
      if (existing || previous) return;
      await delivery(tx, record, text, input.operationId, notify);
      accepted = true;
    }, callContext ?? host.context());
    host.native().resume();
    return { operationId: input.operationId, accepted };
  };
  const cancel = async (id: string, callContext?: Context): Promise<boolean> => {
    host.assertActive();
    const all = Object.values((await state()).agents);
    const selected = new Set([id]);
    if (!all.some(agent => agent.id === id)) throw new Error('Subagent not found');
    for (let depth = 0; depth < MAX_DEPTH; depth++) for (const agent of all) if (agent.parentSubagentId && selected.has(agent.parentSubagentId)) selected.add(agent.id);
    for (const agent of all.filter(agent => selected.has(agent.id))) {
      callContext?.abortSignal?.throwIfAborted();
      await update(agent.id, { status: 'cancelled' });
      await host.harness().session(agent.conversationId).abort();
    }
    return true;
  };
  const tools = () => {
    const guarded = async (api: ToolExecutionApi, context: Context, run: (parentOperationId: string, operationId: string) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      host.assertActive();
      const parentOperationId = await host.operationForCall(api, context);
      const operationId = await computerToolOperationId(String(api.taskId), api.callId);
      const sender = await forConversation(api.conversationId);
      if (sender?.status === 'cancelled') throw new Error('Subagent was cancelled');
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      for (const id of live?.run?.inputs ?? []) {
        const request = await host.storage().submission(id, context);
        const pending = request?.requestId ? host.paused(request.requestId) : undefined;
        if (pending) return { ...content(pending), control: { terminate: true } };
      }
      host.consume(parentOperationId, 'tool', operationId);
      context.abortSignal?.throwIfAborted();
      return run(parentOperationId, operationId);
    };
    const id = Type.String({ minLength: 1, maxLength: 160 });
    return [
      defineTool({ name: 'spawn_subagent', description: 'Create a temporary native Pi subagent with its own context. It shares this bot’s computer and approval policy. Give a concrete self-contained task. Work runs concurrently; inspect or wait for its result. At most 8 active agents and 3 levels.', replay: 'safe',
        parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), task: Type.String({ minLength: 1, maxLength: 20_000 }) }),
        execute: (input, api, context) => guarded(api, context, async (parentOperationId, operationId) => {
          await host.scheduleWake();
          const parent = await forConversation(api.conversationId);
          const agent = await api.commit(async tx => {
            const registry = await tx.doc(Registry);
            const previous = Object.values(registry.agents).find(agent => agent.spawnOperationId === operationId);
            if (previous) return { ...previous };
            if (Object.values(registry.agents).filter(agent => active.has(agent.status)).length >= MAX_AGENTS) throw new Error('At most 8 subagents may be active');
            const depth = (parent?.depth ?? 0) + 1;
            if (depth > MAX_DEPTH) throw new Error('Subagents may be nested at most 3 levels');
            const anchor = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
            const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
            await configure(tx, child.id, { instructions: `You are temporary subagent ${input.name}. Complete your assigned task. Coordinate with other temporary agents using send_subagent_message; use targetId "parent" to contact your parent. Share only public findings, never private reasoning. You share the parent bot’s computer and must coordinate file edits.` });
            const now = new Date().toISOString();
            const record: StoredAgent = { id: crypto.randomUUID(), name: input.name, task: input.task,
              parentOperationId, ...(parent ? { parentSubagentId: parent.id } : {}),
              operationId, status: 'queued', createdAt: now, updatedAt: now, conversationId: String(child.id), depth, spawnOperationId: operationId };
            registry.agents[record.id] = record;
            await delivery(tx, record, input.task, operationId, true);
            return record;
          }, context);
          await api.details({ subagentId: agent.id }, context);
          await host.emit({ type: 'subagent.created', operationId: parentOperationId, eventKey: `subagent:created:${agent.id}`, data: { subagent: publicAgent(agent), operationId, toolCallId: api.callId } });
          await attach(agent.id);
          return content({ subagent: publicAgent(agent) });
        }) }),
      defineTool({ name: 'list_subagents', description: 'List temporary subagents, their status and public final results.', replay: 'safe', parameters: Type.Object({}),
        execute: (_input, api, context) => guarded(api, context, async () => content({ subagents: Object.values((await state()).agents).map(publicAgent) })) }),
      defineTool({ name: 'send_subagent_message', description: 'Send a durable message to another temporary agent by its ID. A child may use targetId "parent". Messages start a new turn or queue behind active work.', replay: 'safe',
        parameters: Type.Object({ targetId: id, text: Type.String({ minLength: 1, maxLength: 20_000 }) }),
        execute: (input, api, context) => guarded(api, context, async (parentOperationId, operationId) => {
          const sender = await forConversation(api.conversationId);
          const parentName = await host.botName();
          const sourceName = sender?.name ?? parentName;
          const sent = async (receipt: RuntimeReceipt, target?: StoredAgent): Promise<ToolExecutionResult> => {
            await host.emit({ type: 'subagent.message.sent', operationId: parentOperationId,
              eventKey: `subagent:message-sent:${operationId}`, data: {
                ...(sender ? { sourceSubagentId: sender.id } : {}), ...(target ? { targetSubagentId: target.id } : {}),
                sourceName, targetName: target?.name ?? parentName, text: input.text, operationId, toolCallId: api.callId,
              } });
            return content(receipt);
          };
          if (input.targetId === 'parent') {
            if (!sender) throw new Error('The main bot has no temporary parent');
            if (sender.parentSubagentId) {
              const parent = await find(sender.parentSubagentId);
              return sent(await send(parent.id, input.text, { operationId }, false, context), parent);
            }
            if (!host.onMessage) throw new Error('Parent messaging is not configured');
            await host.onMessage({ subagentId: sender.id, parentOperationId, operationId, text: `Message from subagent ${sender.name}:\n${input.text}` });
            return sent({ operationId, accepted: true });
          }
          const target = await find(input.targetId);
          if (sender && target.parentOperationId !== parentOperationId) throw new Error('Subagent belongs to another task');
          return sent(await send(target.id, `Message from ${sender?.name ?? 'parent'}:\n${input.text}`, { operationId }, false, context), target);
        }) }),
      defineTool({ name: 'wait_subagent', description: 'Wait for a temporary agent’s current task and return its public result. Yield promptly when a new steering input arrives so you can handle it while the child keeps working. Waiting survives recovery; approval or connection waits are returned immediately for host review.', replay: 'safe',
        parameters: Type.Object({ subagentId: id }), execute: (input, api, context) => guarded(api, context, async (parentOperationId) => {
          const agent = await find(input.subagentId);
          const sender = await forConversation(api.conversationId);
          if ((sender && agent.parentOperationId !== parentOperationId) || agent.conversationId === String(api.conversationId)) throw new Error('Invalid subagent wait');
          const controller = new AbortController();
          const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal;
          const waitContext: Context = { abortSignal: signal, value: key => context.value(key), toString: () => context.toString() };
          const inbox = await api.watchDoc(InboxDoc, api.conversationId, context);
          let yieldToInput!: () => void;
          const incoming = new Promise<'input'>(resolve => { yieldToInput = () => resolve('input'); });
          const notice = (value: Readonly<InboxState> | null) => {
            if (value?.items.some(item => item.mode === 'steer')) yieldToInput();
          };
          try {
            // Acquisition includes an exact initial frame; starting its listener
            // before checking that frame also covers admission during this call.
            inbox?.start(async value => { notice(value); });
            if (inbox) notice(inbox.value);
            const done = (async () => {
              const pending = (await state()).deliveries[`${agent.id}:${agent.operationId}`];
              if (pending) await api.waitForTask(pending.taskId as TaskId, waitContext);
              return host.harness().session(agent.conversationId).wait(agent.operationId, signal);
            })();
            const result = await Promise.race([done, incoming]);
            if (result === 'input') return content({ status: 'yielded', reason: 'new_input', subagent: publicAgent(await find(agent.id)) });
            return content({ subagent: publicAgent(await find(agent.id)), result });
          } finally {
            // Cancel only our observer. Native child work and its delivery stay
            // alive; ending this safe tool lets Pi place the incoming steer.
            controller.abort(new Error('Subagent wait observer finished'));
            await inbox?.stop();
          }
        }) }),
      defineTool({ name: 'cancel_subagent', description: 'Cancel a temporary agent and its descendants. Cancelled agents cannot be restarted; create a new agent for new work.', replay: 'unsafe',
        parameters: Type.Object({ subagentId: id }), execute: (input, api, context) => guarded(api, context, async parentOperationId => {
          const agent = await find(input.subagentId);
          const sender = await forConversation(api.conversationId);
          if ((sender && agent.parentOperationId !== parentOperationId) || agent.conversationId === String(api.conversationId)) throw new Error('Invalid subagent cancellation');
          return content({ cancelled: await cancel(agent.id, context) });
        }) }),
    ];
  };
  return {
    tools, tasks: [Anchor, DeliveryTask], forConversation,
    async start() { for (const agent of Object.values((await state()).agents)) await attach(agent.id); },
    async stop() { stopped = true; await Promise.all([...streams.values()].map(stream => stream.stop())); },
    async hasDeliveries() { return (await host.native().inspect(host.context())).tasks.some(task => task.record.kind === 'timber.subagent-delivery'); },
    async list() { return Object.values((await state()).agents).map(publicAgent); },
    async messages(id: string) { const agent = await find(id); return normalizeEntries(await host.harness().session(agent.conversationId).messages()).filter(message => message.role !== 'tool' && message.role !== 'system'); },
    send, cancel,
    async cancelParent(operationId?: string) { for (const agent of Object.values((await state()).agents)) if ((!operationId || agent.parentOperationId === operationId) && agent.status !== 'cancelled') await cancel(agent.id); },
  };
}
