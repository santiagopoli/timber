/** Deterministic test adapter. Production never imports this file. */
import type { PiRuntimeOptions, RuntimeMessage, RuntimeSubagent } from "../../packages/runtime/src/types";
export const DEFAULT_MODEL = "@cf/test/mock";
export { parseRuntimeLimit } from "../../packages/runtime/src/budget";
export type { RuntimeEvent, RuntimeToolRequest } from "../../packages/runtime/src/types";

type Result = {operationId: string; session: "1"; status: "done" | "unanswered"; text?: string; reason?: string};
type Operation = {text: string; status: "queued" | "running" | "done" | "unanswered"; result?: Result};
const fixtureEvents = new Map<string, (type: string, data: Record<string, unknown>) => Promise<void>>();
export async function emitFixtureRuntimeEvent(operationId: string, type: string, data: Record<string, unknown>) {
  const emit = fixtureEvents.get(operationId);
  if (!emit) throw new Error("Unknown fixture operation");
  await emit(type, data);
}

export function createPiRuntime<Env extends object>(options: PiRuntimeOptions<Env>) {
  const pending = new Map<string, Promise<Result>>();
  let destroyed = false;
  const assertActive = () => { if (destroyed) throw new Error("Runtime has been destroyed"); };
  const key = (id: string) => `fixture-runtime:${id}`;
  const childKey = (id: string) => `fixture-subagent:${id}`;
  const saveChild = async (subagent: RuntimeSubagent) => {
    await options.storage.put(childKey(subagent.id), subagent);
    await options.onEvent?.({type: "subagent.updated", operationId: subagent.parentOperationId, data: {subagent}});
  };
  const cancelChild = async (id: string): Promise<boolean> => {
    const child = await options.storage.get<RuntimeSubagent>(childKey(id));
    if (!child || ["completed", "failed", "cancelled"].includes(child.status)) return false;
    await saveChild({...child, status: "cancelled", updatedAt: new Date().toISOString()});
    return true;
  };
  const emit = async (operationId: string, type: string, data: Record<string, unknown>) => {
    if (destroyed) return;
    await options.onEvent?.({operationId, type, data, eventKey: `${operationId}:${type}`});
  };
  async function execute(operationId: string): Promise<Result> {
    const operation = await options.storage.get<Operation>(key(operationId));
    if (!operation) return {operationId, session: "1", status: "unanswered", reason: "not_found"};
    if (operation.result) return operation.result;
    operation.status = "running";
    await options.storage.put(key(operationId), operation);
    await emit(operationId, "run.started", {});
    await new Promise(resolve => setTimeout(resolve, 15));
    if (destroyed) return {operationId, session: "1", status: "unanswered", reason: "aborted"};
    if (["fixture:model-error", "fixture:model-error-late"].includes(operation.text)) {
      const result: Result = {operationId, session: "1", status: "unanswered", reason: "model_error"};
      await options.storage.put(key(operationId), {...operation, status: "unanswered", result});
      if (operation.text === "fixture:model-error") await emit(operationId, "run.failed", {
        reason: "model_error", errorCode: "model_billing_required",
        publicMessage: "This model requires a paid Cloudflare Workers plan.",
      });
      return result;
    }
    if (["fixture:approval", "fixture:gui-approval"].includes(operation.text)) {
      const result = await options.tools.execute({
        operationId: `fixture-tool:${operationId}`, runOperationId: operationId,
        action: operation.text === "fixture:gui-approval"
          ? {type: "click", x: 20, y: 30}
          : {type: "exec", command: "printf original-approved-command"}, signal: new AbortController().signal,
      });
      if (destroyed) return {operationId, session: "1", status: "unanswered", reason: "aborted"};
      if (result.status === "pending_approval") {
        const paused: Result = {operationId, session: "1", status: "unanswered", reason: "terminated"};
        await options.storage.put(key(operationId), {...operation, status: "unanswered", result: paused});
        await emit(operationId, "run.failed", {reason: "terminated"});
        return paused;
      }
    }
    if (["fixture:github", "fixture:github-account"].includes(operation.text)) {
      if (!options.tools.call) throw new Error("Host tools fixture requires a host bridge");
      const result = await options.tools.call({
        operationId: `fixture-host:${operationId}`, runOperationId: operationId,
        name: operation.text === "fixture:github-account" ? "github_connect" : "github_clone", arguments: operation.text === "fixture:github-account" ? {} : {repository: "Owner/Private", path: "project"},
        signal: new AbortController().signal,
      });
      await options.storage.put(`fixture-host-result:${operationId}`, result);
      if (result.status === "pending_connection") {
        const paused: Result = {operationId, session: "1", status: "unanswered", reason: "terminated"};
        await options.storage.put(key(operationId), {...operation, status: "unanswered", result: paused});
        await emit(operationId, "run.failed", {reason: "terminated"});
        return paused;
      }
    }
    if (operation.text === "fixture:subagent-approval") {
      const children = await options.storage.list<RuntimeSubagent>({prefix: "fixture-subagent:"});
      let child = [...children.values()].find(value => value.parentOperationId === operationId);
      if (!child) {
        const now = new Date().toISOString(), id = crypto.randomUUID();
        child = {id, name: "Temporary researcher", task: "Run a command with approval", parentOperationId: operationId, operationId: `fixture-child:${id}`, status: "running", createdAt: now, updatedAt: now};
        await saveChild(child);
        const tool = await options.tools.execute({
          operationId: `fixture-child-tool:${id}`, runOperationId: operationId,
          subagentId: id, subagentOperationId: child.operationId,
          action: {type: "exec", command: "printf child-approved-command"}, signal: new AbortController().signal,
        });
        child = {...child, status: tool.status === "pending_approval" ? "waiting_approval" : "completed", updatedAt: new Date().toISOString()};
        await saveChild(child);
      }
    }
    const result: Result = {operationId, session: "1", status: "done", text: `Fixture answer: ${operation.text}`};
    const message: RuntimeMessage = {id: `fixture-answer:${operationId}`, role: "assistant", text: result.text!, createdAt: new Date().toISOString()};
    await options.storage.put(`fixture-message:${operationId}`, message);
    await emit(operationId, "message", {...message});
    await options.storage.put(key(operationId), {...operation, status: "done", result});
    await emit(operationId, "run.completed", {text: result.text});
    return result;
  }
  return {
    async scheduleAdmissionRetry(operationId: string, delayMs: number) {
      assertActive();
      // Tests explicitly dispatch this durable intent; no wall-clock timer.
      await options.storage.put(`fixture-admission-retry:${operationId}`, {operationId, delayMs, dueAt: Date.now() + delayMs});
    },
    async submit(text: string, input: {operationId: string}) {
      assertActive();
      fixtureEvents.set(input.operationId, (type, data) => emit(input.operationId, type, data));
      const existing = await options.storage.get(key(input.operationId));
      if (!existing) await options.storage.put(key(input.operationId), {text, status: "queued"});
      return {operationId: input.operationId, session: "1" as const, accepted: !existing};
    },
    wait(operationId: string) {
      let promise = pending.get(operationId);
      if (!promise) {promise = execute(operationId); pending.set(operationId, promise);}
      return promise;
    },
    async operation(operationId: string) {
      const operation = await options.storage.get<Operation>(key(operationId));
      return {operationId, status: operation?.status ?? "missing", ...operation?.result};
    },
    async pending() {
      const all = await options.storage.list<Operation>({prefix: "fixture-runtime:"});
      return [...all.entries()].filter(([, value]) => ["queued", "running"].includes(value.status))
        .map(([id, value]) => ({operationId: id.slice("fixture-runtime:".length), session: "1", status: value.status}));
    },
    async messages() {return [...(await options.storage.list<RuntimeMessage>({prefix: "fixture-message:"})).values()];},
    async subagents() {
      assertActive();
      return [...(await options.storage.list<RuntimeSubagent>({prefix: "fixture-subagent:"})).values()];
    },
    async subagentMessages(id: string) {
      assertActive();
      return [...(await options.storage.list<RuntimeMessage>({prefix: `fixture-subagent-message:${id}:`})).values()];
    },
    async sendSubagent(id: string, text: string, input: {operationId: string}) {
      assertActive();
      const child = await options.storage.get<RuntimeSubagent>(childKey(id));
      if (!child) throw new Error("Subagent not found");
      const inputKey = `fixture-subagent-input:${id}:${input.operationId}`;
      const previous = await options.storage.get<string>(inputKey);
      if (previous !== undefined) {
        if (previous !== text) throw new Error("Subagent input conflict");
        return {operationId: input.operationId, accepted: false};
      }
      if (child.status === "cancelled") throw new Error("Subagent cancelled");
      await options.storage.put(inputKey, text);
      const createdAt = new Date().toISOString();
      if (text === "fixture:subagent-approval") {
        const active = {...child, operationId: input.operationId, status: "running" as const, updatedAt: createdAt};
        await saveChild(active);
        const tool = await options.tools.execute({
          operationId: `fixture-child-tool:${id}:${input.operationId}`, runOperationId: child.parentOperationId,
          subagentId: id, subagentOperationId: input.operationId,
          action: {type: "exec", command: "printf child-followup-approved-command"}, signal: new AbortController().signal,
        });
        await saveChild({...active, status: tool.status === "pending_approval" ? "waiting_approval" : "completed", updatedAt: new Date().toISOString()});
        return {operationId: input.operationId, accepted: true};
      }
      const message: RuntimeMessage = {id: `fixture-child-answer:${input.operationId}`, role: "assistant", kind: "final", text: `Fixture child answer: ${text}`, createdAt};
      await options.storage.put(`fixture-subagent-message:${id}:${input.operationId}`, message);
      await saveChild({...child, operationId: input.operationId, status: "completed", result: message.text, updatedAt: createdAt});
      return {operationId: input.operationId, accepted: true};
    },
    async cancelSubagent(id: string) {
      assertActive();
      return cancelChild(id);
    },
    async cancel(operationId?: string) {
      if (!operationId) return false;
      const operation = await options.storage.get<Operation>(key(operationId));
      if (!operation) return false;
      await options.storage.put(key(operationId), {...operation, status: "unanswered", result: {operationId, session: "1", status: "unanswered", reason: "aborted"}});
      const children = await options.storage.list<RuntimeSubagent>({prefix: "fixture-subagent:"});
      for (const child of children.values()) if (child.parentOperationId === operationId) await cancelChild(child.id);
      return true;
    },
    async dispose() {},
    async destroy() {
      destroyed = true;
      await Promise.allSettled(pending.values());
      for (const id of pending.keys()) fixtureEvents.delete(id);
      const wakes = await options.storage.list({prefix: "fixture-admission-retry:"});
      if (wakes.size) await options.storage.delete([...wakes.keys()]);
      await options.storage.deleteAlarm();
    },
  };
}
