/** Deterministic test adapter. Production never imports this file. */
import type { PiRuntimeOptions, RuntimeMessage } from "../../packages/runtime/src/types";
export const DEFAULT_MODEL = "@cf/test/mock";
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
  const key = (id: string) => `fixture-runtime:${id}`;
  const emit = async (operationId: string, type: string, data: Record<string, unknown>) => {
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
      if (result.status === "pending_approval") {
        const paused: Result = {operationId, session: "1", status: "unanswered", reason: "terminated"};
        await options.storage.put(key(operationId), {...operation, status: "unanswered", result: paused});
        await emit(operationId, "run.failed", {reason: "terminated"});
        return paused;
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
    async submit(text: string, input: {operationId: string}) {
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
    async cancel(operationId?: string) {
      if (!operationId) return false;
      const operation = await options.storage.get<Operation>(key(operationId));
      if (!operation) return false;
      await options.storage.put(key(operationId), {...operation, status: "unanswered", result: {operationId, session: "1", status: "unanswered", reason: "aborted"}});
      return true;
    },
    async dispose() {},
  };
}
