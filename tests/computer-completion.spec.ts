import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerResult } from "@botspace/contracts";

const bindings = env as unknown as {REAL_COMPUTER: DurableObjectNamespace};
const PRIVATE_DETAIL = "private-provider-token-and-command";

/** Keep the real DO lifecycle and SQLite journal, replacing only native I/O. */
async function injectContainer(stub: DurableObjectStub, failure: "after_result" | "before_effect") {
  await runInDurableObject(stub, (instance, state) => {
    let effects = 0;
    let healthy = false;
    const container = {
      running: true,
      async setInactivityTimeout() {
        if (failure === "after_result" ? effects > 0 : healthy) throw new Error(PRIVATE_DETAIL);
      },
      getTcpPort() {
        return {
          async fetch(input: string) {
            if (new URL(input).pathname === "/health") {
              healthy = true;
              return Response.json({ok: true, bootId: "test-boot", desktop: true});
            }
            expect(new URL(input).pathname).toBe("/actions");
            effects++;
            await state.storage.put("fixture:effects", effects);
            return Response.json({status: "completed", output: "Desktop effect completed"});
          },
        };
      },
    };
    Object.defineProperty(instance, "container", {get: () => container});
  });
}

function submit(stub: DurableObjectStub, botId: string) {
  return stub.fetch("https://computer.internal/actions", {
    method: "POST", body: JSON.stringify({botId, operationId: "approved-effect", action: {type: "click", x: 10, y: 20}}),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("computer result durability at lifetime renewal", () => {
  it("returns the committed result when final renewal fails and never repeats the effect", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await injectContainer(stub, "after_result");

    const first = await submit(stub, botId);
    expect(first.status).toBe(200);
    const result = await first.json<ComputerResult>();
    expect(result).toEqual({operationId: "approved-effect", status: "completed", output: "Desktop effect completed"});
    const repeated = await submit(stub, botId);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(result);
    const saved = await runInDurableObject(stub, async (_instance, state) => ({
      effects: await state.storage.get("fixture:effects"),
      operation: await state.storage.get<{result: ComputerResult}>("operation:approved-effect"),
    }));
    expect(saved.effects).toBe(1);
    expect(saved.operation?.result).toEqual(result);
    expect(log).toHaveBeenCalledWith("computer.failure", {stage: "post_result_touch", code: "computer_lifecycle_failed"});
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE_DETAIL);
  });

  it("still fails before journaling or executing if initial renewal fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await injectContainer(stub, "before_effect");

    const response = await submit(stub, botId);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error: {code: "computer_lifecycle_failed"}});
    const saved = await runInDurableObject(stub, async (_instance, state) => ({
      effects: await state.storage.get("fixture:effects"),
      operation: await state.storage.get("operation:approved-effect"),
    }));
    expect(saved.effects).toBeUndefined();
    expect(saved.operation).toBeUndefined();
  });
});
