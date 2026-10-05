import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ComputerAction, ComputerResult } from "@botspace/contracts";

const bindings = env as unknown as {REAL_COMPUTER: DurableObjectNamespace};
async function digest(action: ComputerAction) {
  const data = new TextEncoder().encode(JSON.stringify(action, Object.keys(action).sort()));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function action(stub: DurableObjectStub, botId: string, operationId: string, value: ComputerAction) {
  const response = await stub.fetch("https://computer.internal/actions", {
    method: "POST", body: JSON.stringify({botId, operationId, action: value}),
  });
  expect(response.status).toBe(200);
  return response.json<ComputerResult>();
}

describe("real ComputerDO journal recovery without a container", () => {
  it("does not replay an action whose outcome was unknown before object eviction", async () => {
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const request: ComputerAction = {type: "exec", command: "external-side-effect"};
    const hash = await digest(request);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("operation:unknown-action", {digest: hash});
    });
    await evictDurableObject(stub);
    const result = await action(stub, botId, "unknown-action", request);
    expect(result.status).toBe("interrupted");
    expect(result.error).toContain("Inspect effects");
    expect(await action(stub, botId, "unknown-action", request)).toEqual(result);
    // There is no container in this suite: trying to run the command would fail,
    // rather than return this previously persisted interrupted journal result.
    const changed = await action(stub, botId, "unknown-action", {type: "exec", command: "different-side-effect"});
    expect(changed.status).toBe("failed");
    expect(changed.error).toContain("different arguments");
  });

  it("returns a completed result after eviction without starting a fresh computer", async () => {
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const request: ComputerAction = {type: "writeFile", path: "notes.txt", content: "done"};
    const result: ComputerResult = {operationId: "completed-action", status: "completed", output: "already done", checkpointId: "saved-checkpoint"};
    const hash = await digest(request);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("operation:completed-action", {digest: hash, result});
    });
    await evictDurableObject(stub);
    expect(await action(stub, botId, "completed-action", request)).toEqual(result);
  });
});
