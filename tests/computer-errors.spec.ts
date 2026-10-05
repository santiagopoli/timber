import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerProviderError, createCloudComputerProvider } from "@botspace/computer";
import { computerFixtureControl } from "./fixtures/worker";

const PRIVATE_DETAIL = "private-provider-token secret-command /private/account/location";
function provider(fetch: () => Promise<Response>) {
  const binding = {idFromName: (name: string) => name, get: () => ({fetch})} as unknown as DurableObjectNamespace;
  return createCloudComputerProvider(binding);
}
async function captureError(work: Promise<unknown>): Promise<ComputerProviderError> {
  try {await work;} catch (error) {
    expect(error).toBeInstanceOf(ComputerProviderError);
    return error as ComputerProviderError;
  }
  throw new Error("Expected a sanitized computer provider failure");
}
afterEach(() => {delete computerFixtureControl.failure;});

describe("computer RPC error boundary", () => {
  it("preserves an allowlisted diagnostic code while discarding the provider message", async () => {
    const computer = provider(async () => Response.json({error: {code: "computer_start_failed", message: PRIVATE_DETAIL}}, {status: 503}));
    const error = await captureError(computer.exec("bot", "operation", {type: "listFiles"}));
    expect(error.code).toBe("computer_start_failed");
    expect(error.status).toBe(503);
    expect(error.publicMessage).toBe("Cloudflare could not start the computer. Check Containers access, provisioning, and instance capacity.");
    expect(String(error)).not.toContain(PRIVATE_DETAIL);
  });

  it.each([
    {error: {code: "unknown_provider_error", message: PRIVATE_DETAIL}},
    {error: PRIVATE_DETAIL},
    {error: {code: "__proto__", message: PRIVATE_DETAIL}},
  ])("maps untrusted error structures to a fixed unavailable diagnostic", async (body) => {
    const computer = provider(async () => Response.json(body, {status: 502}));
    const error = await captureError(computer.status("bot"));
    expect(error).toMatchObject({code: "computer_unavailable", status: 503, publicMessage: "The cloud computer is unavailable. Try again shortly."});
    expect(String(error)).not.toContain(PRIVATE_DETAIL);
  });

  it("caps and cancels oversized error bodies without trusting their embedded code", async () => {
    let cancelled = false;
    const computer = provider(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(new TextEncoder().encode(JSON.stringify({error: {code: "computer_start_failed", message: PRIVATE_DETAIL.repeat(100)}})));},
      cancel() {cancelled = true;},
    }), {status: 503}));
    const error = await captureError(computer.status("bot"));
    expect(error.code).toBe("computer_unavailable");
    expect(cancelled).toBe(true);
    expect(String(error)).not.toContain(PRIVATE_DETAIL);
  });

  it("hides network exceptions and malformed provider responses", async () => {
    for (const fetch of [
      async () => {throw new Error(PRIVATE_DETAIL);},
      async () => new Response(`<html>${PRIVATE_DETAIL}</html>`, {status: 502}),
      async () => new Response(PRIVATE_DETAIL, {status: 200}),
    ]) {
      const error = await captureError(provider(fetch).status("bot"));
      expect(error).toMatchObject({code: "computer_unavailable", status: 503});
      expect(String(error)).not.toContain(PRIVATE_DETAIL);
    }
  });
});

describe("computer failures through the authenticated public API", () => {
  it("returns a safe structured 503 instead of a generic 500", async () => {
    const headers = {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"};
    const creation = await exports.default.fetch("https://timber.test/v1/bots", {method: "POST", headers, body: JSON.stringify({name: "diagnostic-test"})});
    expect(creation.status).toBe(201);
    const {bot} = await creation.json<{bot: {id: string}}>();
    computerFixtureControl.failure = {status: 503, body: {error: {code: "computer_provisioning_failed", message: PRIVATE_DETAIL}}};
    const response = await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/computer/actions`, {
      method: "POST", headers, body: JSON.stringify({operationId: crypto.randomUUID(), action: {type: "listFiles"}}),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({error: {code: "computer_provisioning_failed", message: "The cloud computer could not install its desktop packages."}});
    expect(text).not.toContain(PRIVATE_DETAIL);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
