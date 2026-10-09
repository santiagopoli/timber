type ToolResult = {
  status?: string; processId?: string; output?: string; error?: string; exitCode?: number;
  checkpointStatus?: 'pending' | 'saved' | 'failed'; checkpointId?: string;
};
const settled = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired']);
const terminalRuns = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Native cancellation notifications cannot rewrite an already settled effect. */
export function mergeToolStatus(previous?: string, incoming?: string): string | undefined {
  if (!incoming) return previous;
  if (previous && settled.has(previous) && incoming !== previous) return previous;
  if (previous === 'interrupted' && ['running', 'queued'].includes(incoming)) return previous;
  return incoming;
}

/** Merge structured effect receipts only. A native wrapper status is not a process result. */
export function mergeToolResult<T extends ToolResult>(previous?: T, incoming?: T, options?: {snapshot?: boolean}): T | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (mergeToolStatus(previous.status, incoming.status) !== (incoming.status ?? previous.status)) return previous;
  const merged = options?.snapshot ? {...incoming} : {...previous, ...incoming};
  // Persistence observations can arrive after the original completion receipt.
  if (previous.checkpointStatus === 'saved' && incoming.checkpointStatus !== 'saved') {
    merged.checkpointStatus = previous.checkpointStatus;
    merged.checkpointId = previous.checkpointId;
    merged.error = previous.error;
  }
  return merged;
}

type Activity = {returned: boolean; status?: string; result?: ToolResult; data: Record<string, unknown>};
type ActivityRun = {status: string};

export function toolActivityState(tool: Activity, run?: ActivityRun) {
  const active = Boolean(run && !terminalRuns.has(run.status));
  const observed = tool.result?.status || tool.status;
  const managedProcess = Boolean(tool.result?.processId || tool.data.processId);
  const stoppedByRun = run?.status === 'cancelled' && !managedProcess && ((!observed && !tool.returned) || ['running', 'queued', 'pending_approval', 'pending_connection'].includes(observed || ''));
  const status = stoppedByRun ? 'cancelled' : observed;
  const pending = status === 'pending_approval' || status === 'pending_connection';
  const running = status === 'running' && managedProcess || ((!tool.returned && !status || status === 'running') && active);
  const unknown = !stoppedByRun && !running && !tool.returned && (!status || status === 'running') && !active;
  const cancelled = status === 'cancelled';
  const failed = ['failed', 'interrupted', 'denied', 'expired'].includes(status || '');
  const text = unknown ? 'Outcome unconfirmed'
    : status === 'pending_connection' ? 'Connection requested'
    : pending ? 'Approval requested'
    : status === 'completed' ? 'Completed'
    : cancelled ? 'Cancelled'
    : running ? tool.data.cancellationRequested || run?.status === 'cancelled' ? 'Stopping…' : 'Running'
    : status ? status.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase()) : 'Returned';
  return {status: unknown ? 'unconfirmed' : status || (running ? 'running' : 'returned'), text, running, failed, pending, cancelled, unknown};
}

export function toolFailureSummary(result: ToolResult | undefined, state: ReturnType<typeof toolActivityState>): string | undefined {
  if (state.cancelled) return undefined;
  if (result?.error) return result.error;
  if (state.unknown) return 'No result was recorded. Inspect its effects before retrying.';
  if (!state.failed) return undefined;
  if (result?.exitCode !== undefined && result.exitCode !== 0) return `Command exited with code ${result.exitCode}.`;
  if (state.status === 'interrupted') return 'No final result was confirmed. Inspect its effects before retrying.';
  return 'No error details were recorded.';
}

export type Cancellation = {id: string; requestedRunId: string};
type OutcomeRun = {id: string; status: string; subagentId?: string; parentRunId?: string; cancellation?: Cancellation};
type OutcomeEvent = {type: string; createdAt: string; data: Record<string, unknown>};
export type RunOutcome<T extends OutcomeRun> = {run: T; kind: 'stopped' | 'failure'; key: string; cancellationId?: string; createdAt?: string};

/** Group only explicit cancellation identities or recorded parent relationships. */
export function runOutcomes<T extends OutcomeRun>(runs: readonly T[], events: readonly OutcomeEvent[], runFilter?: string | null): RunOutcome<T>[] {
  const byId = new Map(runs.map(run => [run.id, run]));
  const groups = new Map<string, {cancellation: Cancellation; createdAt?: string; members: T[]}>();
  const outcomes: RunOutcome<T>[] = [];
  for (const event of events) {
    if (event.type !== 'run.cancellation.requested') continue;
    const cancellation = event.data.cancellation as Partial<Cancellation> | undefined;
    if (typeof cancellation?.id === 'string' && typeof cancellation.requestedRunId === 'string') {
      groups.set(cancellation.id, {cancellation: cancellation as Cancellation, createdAt: event.createdAt, members: []});
    }
  }
  for (const run of runs) {
    if (run.status !== 'cancelled') {
      if (!run.subagentId && ['failed', 'interrupted'].includes(run.status) && (!runFilter || run.id === runFilter)) outcomes.push({run, kind: 'failure', key: run.id});
      continue;
    }
    let root: T = run;
    const visited = new Set<string>();
    while (!run.cancellation && root.parentRunId && !visited.has(root.id)) {
      visited.add(root.id);
      const parent = byId.get(root.parentRunId);
      if (!parent || parent.status !== 'cancelled') break;
      root = parent;
    }
    const recorded = [...groups.values()].reverse().find(group => group.cancellation.requestedRunId === root.id)?.cancellation;
    const cancellation = run.cancellation ?? recorded ?? {id: `legacy:${root.id}`, requestedRunId: root.id};
    const group = groups.get(cancellation.id) ?? {cancellation, members: []};
    group.members.push(run);
    groups.set(cancellation.id, group);
  }
  for (const [id, group] of groups) {
    const requested = byId.get(group.cancellation.requestedRunId);
    const selected = runFilter ? group.members.find(run => run.id === runFilter) ?? (requested?.id === runFilter ? requested : undefined)
      : requested && !requested.subagentId ? requested : group.members.find(run => !run.subagentId);
    if (selected) outcomes.push({run: selected, kind: 'stopped', key: `cancellation:${id}`, cancellationId: id, createdAt: group.createdAt});
  }
  return outcomes;
}
