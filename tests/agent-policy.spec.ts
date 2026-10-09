import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bot } from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";

const bindings = env as unknown as Env;
const token = "test-only-botspace-owner-token-000000";
const api = (path: string, body?: unknown, method?: string) => exports.default.fetch(`https://timber.test${path}`, {
  method: method ?? (body === undefined ? "GET" : "POST"),
  headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const registry = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
async function create(allowNamedAgents?: boolean): Promise<Bot> {
  const response = await api("/v1/bots", {name: `Agent policy ${crypto.randomUUID()}`, instructions: "Keep these instructions.", allowNamedAgents});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function get(id: string): Promise<Bot> {
  const response = await api(`/v1/bots/${id}`);
  expect(response.status).toBe(200);
  return (await response.json<{bot: Bot}>()).bot;
}
async function patch(id: string, body: unknown): Promise<Bot> {
  const response = await api(`/v1/bots/${id}`, body, "PATCH");
  expect(response.status).toBe(200);
  return (await response.json<{bot: Bot}>()).bot;
}

describe("standing permission to create named agents", () => {
  it("defaults off and persists explicitly configured boolean values through registry eviction", async () => {
    const bots = await Promise.all([create(), create(false), create(true)]);
    expect(bots.map(bot => bot.allowNamedAgents)).toEqual([false, false, true]);
    await evictDurableObject(registry());
    for (const bot of bots) expect(await get(bot.id)).toEqual(bot);
  });

  it("grants and revokes permission independently of computer authorization and other bots", async () => {
    const bot = await create(), other = await create();
    const granted = await patch(bot.id, {allowNamedAgents: true});
    expect(granted).toEqual({...bot, allowNamedAgents: true, updatedAt: expect.any(String)});
    const automatic = await patch(bot.id, {computerApprovalMode: "automatic"});
    const revoked = await patch(bot.id, {allowNamedAgents: false});
    expect(revoked).toEqual({...automatic, allowNamedAgents: false, updatedAt: expect.any(String)});
    expect(revoked.computerApprovalMode).toBe("automatic");
    expect(await get(other.id)).toEqual(other);
  });

  it("rejects non-boolean permission without partially applying a patch", async () => {
    const bot = await create(true);
    for (const value of [null, 0, 1, "", "false", "true", [], {}, [true]]) {
      for (const method of ["POST", "PATCH"] as const) {
        const response = await api(method === "POST" ? "/v1/bots" : `/v1/bots/${bot.id}`, {
          name: "Rejected permission must not rename the bot", allowNamedAgents: value,
        }, method);
        expect(response.status, `${method} ${JSON.stringify(value)}`).toBe(400);
        expect(await response.json()).toMatchObject({error: {code: "invalid_request"}});
      }
    }
    expect(await get(bot.id)).toEqual(bot);
  });

  it("requires owner authentication to grant or revoke agent creation", async () => {
    const bot = await create();
    for (const authorization of [undefined, "Bearer invalid-owner-token"]) {
      for (const method of ["POST", "PATCH"] as const) {
        const path = method === "POST" ? "/v1/bots" : `/v1/bots/${bot.id}`;
        const response = await exports.default.fetch(`https://timber.test${path}`, {
          method, headers: {"content-type": "application/json", ...(authorization ? {authorization} : {})},
          body: JSON.stringify({name: "Unauthorized agent", allowNamedAgents: true}),
        });
        expect(response.status).toBe(401);
        await response.text();
      }
    }
    expect(await get(bot.id)).toEqual(bot);
  });

  it("does not authorize a legacy bot when unrelated settings change", async () => {
    const created = await create();
    const {allowNamedAgents: _omitted, ...legacy} = created;
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE bots SET data=? WHERE id=?", JSON.stringify(legacy), legacy.id);
    });
    await evictDurableObject(registry());
    expect((await get(legacy.id)).allowNamedAgents).not.toBe(true);
    const renamed = await patch(legacy.id, {name: "Legacy renamed"});
    expect(renamed.allowNamedAgents).not.toBe(true);
    expect((await patch(legacy.id, {allowNamedAgents: true})).allowNamedAgents).toBe(true);
  });

  it("retains concurrent independent permission and name updates", async () => {
    const bot = await create();
    await Promise.all([
      patch(bot.id, {allowNamedAgents: true}),
      patch(bot.id, {name: "Concurrent agent rename"}),
    ]);
    expect(await get(bot.id)).toEqual({...bot, name: "Concurrent agent rename", allowNamedAgents: true, updatedAt: expect.any(String)});
  });

  it("cannot configure an unknown bot or forge creator provenance through owner input", async () => {
    const absent = await api(`/v1/bots/${crypto.randomUUID()}`, {allowNamedAgents: true}, "PATCH");
    expect(absent.status).toBe(404);
    await absent.text();
    const response = await api("/v1/bots", {
      name: "Owner-created bot", allowNamedAgents: true,
      createdByBotId: crypto.randomUUID(), createdByRunId: crypto.randomUUID(),
    });
    // Unknown creation metadata may be rejected or stripped, but cannot become trusted provenance.
    if (response.status === 201) {
      const {bot} = await response.json<{bot: Bot & {createdByBotId?: string; createdByRunId?: string}}>();
      expect(bot.createdByBotId).toBeUndefined();
      expect(bot.createdByRunId).toBeUndefined();
    } else {
      expect(response.status).toBe(400);
      await response.text();
    }
  });
});
