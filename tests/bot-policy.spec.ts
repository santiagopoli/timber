import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bot, ComputerApprovalMode } from "@botspace/contracts";

const bindings = env as unknown as {WORKSPACE: DurableObjectNamespace};
const headers = {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"};
const api = (path: string, init: RequestInit = {}) => exports.default.fetch(`https://timber.test${path}`, {...init, headers});
const registry = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));

async function createBot(computerApprovalMode?: ComputerApprovalMode): Promise<Bot> {
  const response = await api("/v1/bots", {method: "POST", body: JSON.stringify({name: `policy-${crypto.randomUUID()}`, instructions: "Keep my configuration.", computerApprovalMode})});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function getBot(id: string): Promise<Bot> {
  const response = await api(`/v1/bots/${id}`);
  expect(response.status).toBe(200);
  return (await response.json<{bot: Bot}>()).bot;
}
async function patchBot(id: string, patch: object): Promise<Bot> {
  const response = await api(`/v1/bots/${id}`, {method: "PATCH", body: JSON.stringify(patch)});
  expect(response.status).toBe(200);
  return (await response.json<{bot: Bot}>()).bot;
}

describe("per-bot computer approval configuration", () => {
  it("persists an explicit ask default and accepts both documented modes on creation", async () => {
    for (const mode of [undefined, "ask", "automatic"] as const) {
      const bot = await createBot(mode);
      expect(bot.computerApprovalMode).toBe(mode ?? "ask");
      expect(await getBot(bot.id)).toEqual(bot);
    }
  });

  it("allows mode-only updates in both directions without replacing other configuration", async () => {
    const original = await createBot();
    const automatic = await patchBot(original.id, {computerApprovalMode: "automatic"});
    expect(automatic).toEqual({...original, computerApprovalMode: "automatic", updatedAt: expect.any(String)});
    const renamed = await patchBot(original.id, {name: "Renamed while automatic"});
    expect(renamed.computerApprovalMode).toBe("automatic");
    const ask = await patchBot(original.id, {computerApprovalMode: "ask"});
    expect(ask).toEqual({...renamed, computerApprovalMode: "ask", updatedAt: expect.any(String)});
    expect(await getBot(original.id)).toEqual(ask);
  });

  it("rejects non-enum values for both create and patch without changing the stored policy", async () => {
    const original = await createBot("automatic");
    for (const value of [null, true, false, 0, 1, "", "ASK", "Automatic", "auto", "ask ", " automatic", [], {}, ["automatic"]]) {
      for (const method of ["POST", "PATCH"] as const) {
        const path = method === "POST" ? "/v1/bots" : `/v1/bots/${original.id}`;
        const response = await api(path, {method, body: JSON.stringify({name: "Invalid policy must not be stored", computerApprovalMode: value})});
        expect(response.status, `${method} ${JSON.stringify(value)}`).toBe(400);
        expect(await response.json()).toMatchObject({error: {code: "invalid_request"}});
      }
    }
    expect(await getBot(original.id)).toEqual(original);
  });

  it("requires owner authentication to create or change standing authorization", async () => {
    const original = await createBot();
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      for (const method of ["POST", "PATCH"] as const) {
        const path = method === "POST" ? "/v1/bots" : `/v1/bots/${original.id}`;
        const response = await exports.default.fetch(`https://timber.test${path}`, {
          method, headers: {"content-type": "application/json", ...(authorization ? {authorization} : {})},
          body: JSON.stringify({name: "Unauthorized bot", computerApprovalMode: "automatic"}),
        });
        expect(response.status).toBe(401);
        await response.text();
      }
    }
    expect(await getBot(original.id)).toEqual(original);
  });

  it("permits model selection with policy updates and rejects unsupported settings without partially applying a patch", async () => {
    const original = await createBot();
    const selected=await patchBot(original.id,{model:"@cf/test/other",computerApprovalMode:"automatic"});
    expect(selected).toMatchObject({model:"@cf/test/other",computerApprovalMode:"automatic"});
    const response = await api(`/v1/bots/${original.id}`, {
      method: "PATCH", body: JSON.stringify({model: "@cf/test/another", fast:true, computerApprovalMode: "ask",name:"Rejected name"}),
    });
    const result=await response.json();
    expect(response.status).toBe(400);
    expect(result).toMatchObject({error: {code: "invalid_model_settings"}});
    expect(await getBot(original.id)).toEqual(selected);
  });

  it("isolates each bot's policy and preserves it through registry eviction and list responses", async () => {
    const first = await createBot(), second = await createBot();
    await patchBot(first.id, {computerApprovalMode: "automatic"});
    await evictDurableObject(registry());
    expect((await getBot(first.id)).computerApprovalMode).toBe("automatic");
    expect(await getBot(second.id)).toEqual(second);
    const response = await api("/v1/bots");
    expect(response.status).toBe(200);
    const {bots} = await response.json<{bots: Bot[]}>();
    expect(bots.find(bot => bot.id === first.id)?.computerApprovalMode).toBe("automatic");
    expect(bots.find(bot => bot.id === second.id)?.computerApprovalMode).toBe("ask");
  });

  it("keeps legacy missing policy unchanged until explicitly configured", async () => {
    const created = await createBot();
    const {computerApprovalMode: _omitted, ...legacy} = created;
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE bots SET data=? WHERE id=?", JSON.stringify(legacy), legacy.id);
    });
    await evictDurableObject(registry());
    expect(await getBot(legacy.id)).toEqual(legacy);
    const renamed = await patchBot(legacy.id, {name: "Legacy bot with no new authorization"});
    expect(renamed).not.toHaveProperty("computerApprovalMode");
    const stored = await runInDurableObject(registry(), (_instance, state) => {
      return state.storage.sql.exec<{data: string}>("SELECT data FROM bots WHERE id=?", legacy.id).one().data;
    });
    expect(JSON.parse(stored)).not.toHaveProperty("computerApprovalMode");
    const configured = await patchBot(legacy.id, {computerApprovalMode: "automatic"});
    expect(configured.computerApprovalMode).toBe("automatic");
    expect(configured.model).toBe(legacy.model);
  });

  it("retains independent name and policy patches arriving together", async () => {
    const bot = await createBot();
    await Promise.all([
      patchBot(bot.id, {name: "Concurrent rename"}),
      patchBot(bot.id, {computerApprovalMode: "automatic"}),
    ]);
    expect(await getBot(bot.id)).toEqual({...bot, name: "Concurrent rename", computerApprovalMode: "automatic", updatedAt: expect.any(String)});
  });

  it("assigns strictly newer versions when the stored update is ahead of the clock", async () => {
    const bot = await createBot();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE bots SET data=? WHERE id=?", JSON.stringify({...bot, updatedAt: future}), bot.id);
    });
    const automatic = await patchBot(bot.id, {computerApprovalMode: "automatic"});
    const ask = await patchBot(bot.id, {computerApprovalMode: "ask"});
    expect(Date.parse(future)).toBeGreaterThan(Date.now());
    expect(Date.parse(automatic.updatedAt)).toBeGreaterThan(Date.parse(future));
    expect(Date.parse(ask.updatedAt)).toBeGreaterThan(Date.parse(automatic.updatedAt));
    expect(await getBot(bot.id)).toEqual(ask);
  });
});
