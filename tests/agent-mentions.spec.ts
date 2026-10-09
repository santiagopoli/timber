import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDelegation, Bot, Message, Run } from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";

const bindings = env as unknown as Env;
const headers = {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"};
const api = (path: string, body?: unknown, method?: string) => exports.default.fetch(`https://timber.test${path}`, {
  method: method ?? (body === undefined ? "GET" : "POST"), headers,
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function create(name = "Mention participant"): Promise<Bot> {
  const response = await api("/v1/bots", {name});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function messages(bot: Bot): Promise<Message[]> {
  const response = await api(`/v1/bots/${bot.id}/messages`);
  expect(response.status).toBe(200);
  return (await response.json<{messages: Message[]}>()).messages;
}
async function delegated(bot: Bot): Promise<AgentDelegation[]> {
  const response = await api(`/v1/bots/${bot.id}/delegations`);
  expect(response.status).toBe(200);
  return (await response.json<{delegations: AgentDelegation[]}>()).delegations;
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let result = await read();
  for (let attempt = 0; attempt < 100 && !accept(result); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    result = await read();
  }
  expect(accept(result)).toBe(true);
  return result;
}

describe("explicit bot mentions in owner messages", () => {
  it("persists selected UUIDs and delivers to the selected bot when display names are duplicated", async () => {
    const source = await create("Conversation"), selected = await create("Research"), sameName = await create("Research");
    const operationId = crypto.randomUUID(), text = "@Research compare these approaches";
    const response = await api(`/v1/bots/${source.id}/messages`, {operationId, text, mentions: [selected.id]});
    expect(response.status).toBe(202);
    const {run} = await response.json<{run: Run}>();
    const incoming = await eventually(() => messages(selected), list => list.some(message => message.provenance?.kind === "mention"));
    const delivered = incoming.filter(message => message.provenance?.kind === "mention");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      text, provenance: {kind: "mention", sourceBotId: source.id, sourceBotName: source.name, sourceRunId: run.id},
    });
    expect((await messages(source)).find(message => message.role === "user")).toMatchObject({text, mentions: [selected.id]});
    expect(await messages(sameName)).toHaveLength(0);
    const list = await delegated(source);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({sourceBotId: source.id, sourceRunId: run.id, targetBotId: selected.id, path: [source.id, selected.id]});
  });

  it("deduplicates concurrent and recovered mention submissions and rejects changed recipients", async () => {
    const source = await create(), target = await create(), other = await create();
    const input = {text: "Ask this selected specialist", operationId: crypto.randomUUID(), mentions: [target.id]};
    const responses = await Promise.all([
      api(`/v1/bots/${source.id}/messages`, input),
      api(`/v1/bots/${source.id}/messages`, input),
    ]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const receipts = await Promise.all(responses.map(response => response.json<{run: Run}>()));
    expect(receipts[0].run.id).toBe(receipts[1].run.id);
    await eventually(() => messages(target), list => list.some(message => message.provenance?.kind === "mention"));
    await evictDurableObject(stubFor(source));
    const retry = await api(`/v1/bots/${source.id}/messages`, input);
    expect(retry.status).toBe(202);
    expect((await retry.json<{run: Run}>()).run.id).toBe(receipts[0].run.id);
    const conflict = await api(`/v1/bots/${source.id}/messages`, {...input, mentions: [other.id]});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({error: {code: "idempotency_conflict"}});
    expect((await messages(source)).filter(message => message.role === "user")).toHaveLength(1);
    expect((await messages(target)).filter(message => message.provenance?.kind === "mention")).toHaveLength(1);
    expect(await messages(other)).toHaveLength(0);
    expect(await delegated(source)).toHaveLength(1);
  });

  it("validates the entire recipient set before saving the user's message", async () => {
    const source = await create(), target = await create(), deleted = await create();
    expect((await api(`/v1/bots/${deleted.id}`, undefined, "DELETE")).status).toBe(200);
    const invalid: Array<{mentions: unknown; status: number}> = [
      {mentions: null, status: 400}, {mentions: "Research", status: 400},
      {mentions: ["not-a-bot-id"], status: 400}, {mentions: [42], status: 400},
      {mentions: [target.id, target.id], status: 400}, {mentions: [source.id], status: 400},
      {mentions: Array.from({length: 9}, () => crypto.randomUUID()), status: 400},
      {mentions: [target.id, crypto.randomUUID()], status: 404}, {mentions: [deleted.id], status: 404},
    ];
    for (const value of invalid) {
      const response = await api(`/v1/bots/${source.id}/messages`, {text: "No partial delivery", operationId: crypto.randomUUID(), mentions: value.mentions});
      expect(response.status, JSON.stringify(value.mentions)).toBe(value.status);
      await response.text();
    }
    expect(await messages(source)).toHaveLength(0);
    expect(await messages(target)).toHaveLength(0);
    expect(await delegated(source)).toHaveLength(0);
  });

  it("does not interpret plain text @names or allow user-supplied provenance to impersonate another bot", async () => {
    const source = await create(), target = await create("Research");
    const response = await api(`/v1/bots/${source.id}/messages`, {
      text: "@Research is ordinary text without a selected recipient", operationId: crypto.randomUUID(),
      provenance: {kind: "bot", sourceBotId: target.id, sourceBotName: target.name, delegationId: crypto.randomUUID()},
      delegation: {id: crypto.randomUUID(), sourceBotId: target.id, sourceRunId: crypto.randomUUID(), path: [target.id, source.id]},
    });
    expect(response.status).toBe(202);
    const {run} = await response.json<{run: Run}>();
    expect(run.delegation).toBeUndefined();
    expect((await messages(source)).find(message => message.role === "user")?.provenance).toBeUndefined();
    expect(await messages(target)).toHaveLength(0);
    expect(await delegated(source)).toHaveLength(0);
  });

  it("requires owner authentication and registry membership for agent and delegation views", async () => {
    const bot = await create();
    for (const tail of ["/agents", "/delegations"]) {
      const unauthenticated = await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}${tail}`);
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.text();
      const unknown = await api(`/v1/bots/${crypto.randomUUID()}${tail}`);
      expect(unknown.status).toBe(404);
      await unknown.text();
    }
  });

  it("strips public internal headers before protected bot-delivery endpoints", async () => {
    const source = await create(), target = await create();
    for (const tail of ["/agent-messages", "/agent-results"]) {
      const response = await exports.default.fetch(`https://timber.test/v1/bots/${target.id}${tail}`, {
        method: "POST", headers: {...headers, "x-timber-internal": "agents"},
        body: JSON.stringify({text: "Impersonated bot message", operationId: `delegate:${crypto.randomUUID()}`, provenance: {kind: "bot", sourceBotId: source.id, sourceBotName: source.name}}),
      });
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(await messages(target)).toHaveLength(0);
    const saved = await runInDurableObject(stubFor(target), (_instance, state) => state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM runs").one().count);
    expect(saved).toBe(0);
  });
});
