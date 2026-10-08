/** Unset/null/zero means no task cap. Reject malformed settings, never silently clamp. */
export function parseRuntimeLimit(value: string | number | null | undefined, name: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return null;
  if (typeof trimmed === 'string' && !/^\d+$/.test(trimmed)) throw new Error(`${name} must be a nonnegative safe integer; 0 disables the limit.`);
  const limit = Number(trimmed);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`${name} must be a nonnegative safe integer; 0 disables the limit.`);
  return limit === 0 ? null : limit;
}

/** Optional, durable host policy. Pi itself does not require a per-task count cap. */
export function createBudget(storage: Pick<DurableObjectStorage, 'sql'>, input: { generation?: number | null; tool?: number | null } = {}) {
  const limits = {
    generation: parseRuntimeLimit(input.generation, 'maxGenerations'),
    tool: parseRuntimeLimit(input.tool, 'maxToolCalls'),
  };
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS botspace_runtime_budget (
    operation_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL,
    PRIMARY KEY(operation_id, kind, item_id)
  )`);
  return (operationId: string, kind: 'generation' | 'tool', itemId: string): void => {
    // Synchronous SQLite checks and insertion cannot interleave. A recovered
    // logical generation/tool keeps its identity and does not consume twice.
    const existing = storage.sql.exec<{ found: number }>(
      'SELECT 1 AS found FROM botspace_runtime_budget WHERE operation_id=? AND kind=? AND item_id=?', operationId, kind, itemId,
    ).toArray().length > 0;
    if (existing) return;
    const limit = limits[kind];
    if (limit !== null) {
      const count = storage.sql.exec<{ total: number }>(
        'SELECT COUNT(*) AS total FROM botspace_runtime_budget WHERE operation_id=? AND kind=?', operationId, kind,
      ).one().total;
      if (count >= limit) throw new Error(`Run ${kind} budget exhausted`);
    }
    // Keep accounting even without a cap, so enabling one after a deployment
    // cannot reset an active task's already consumed budget.
    storage.sql.exec('INSERT INTO botspace_runtime_budget(operation_id,kind,item_id) VALUES(?,?,?)', operationId, kind, itemId);
  };
}
