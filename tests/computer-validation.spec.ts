import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerProviderError, createCloudComputerProvider } from "@botspace/computer";

const bindings = env as unknown as {REAL_COMPUTER: DurableObjectNamespace};
afterEach(() => vi.restoreAllMocks());

describe("computer operation identifiers at the real RPC boundary", () => {
  it("rejects an opaque compound call ID before native access or an effect journal exists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const botId = crypto.randomUUID();
    const operationId = "pi-tool:12:call_test|fc_test";
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const nativeAccess = vi.fn(() => {throw new Error("Native computer must not be reached");});
    await runInDurableObject(stub, (instance) => {
      Object.defineProperty(instance, "container", {get: nativeAccess});
    });

    const provider = createCloudComputerProvider(bindings.REAL_COMPUTER);
    const result = await provider.exec(botId, operationId, {type: "exec", command: "printf should-not-run"})
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ComputerProviderError);
    expect(result).toMatchObject({code: "computer_invalid_request", status: 400});
    expect(nativeAccess).not.toHaveBeenCalled();
    const operations = await runInDurableObject(stub, (_instance, state) => state.storage.list({prefix: "operation:"}));
    expect(operations.size).toBe(0);
  });
});
