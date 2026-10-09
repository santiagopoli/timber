import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bot, Run } from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";
import type { RuntimeHostToolRequest, RuntimeToolResult } from "../packages/runtime/src/types";

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown, method?: string) => exports.default.fetch(`https://timber.test${path}`, {
  method: method ?? (body === undefined ? "GET" : "POST"),
  headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const registry = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const coordinator = (body: object, internal = true) => registry().fetch("https://workspace/agents/create", {
  method: "POST", headers: {"content-type": "application/json", ...(internal ? {"x-timber-internal": "agents"} : {})},
  body: JSON.stringify(body),
});
async function setup(allowNamedAgents = true): Promise<{bot: Bot; run: Run}> {
  const response = await api("/v1/bots", {name: `Creator ${crypto.randomUUID()}`, allowNamedAgents});
  expect(response.status).toBe(201);
  const {bot} = await response.json<{bot: Bot}>();
  const submitted = await api(`/v1/bots/${bot.id}/messages`, {text: "fixture:approval", operationId: crypto.randomUUID()});
  expect(submitted.status).toBe(202);
  let {run} = await submitted.json<{run: Run}>();
  for (let attempt = 0; attempt < 100 && run.status !== "waiting_approval"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    run = (await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run: Run}>()).run;
  }
  expect(run.status).toBe("waiting_approval");
  return {bot, run};
}
function creation(bot: Bot, run: Run, operationId = crypto.randomUUID()) {
  return {sourceBotId: bot.id, sourceRunId: run.id, operationId, name: "Research specialist", instructions: "Research and report your sources."};
}
async function created(body: object): Promise<Bot> {
  const response = await coordinator(body);
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}

describe("durable bot-created named agents", () => {
  it("creates a persistent named bot with host-owned provenance and independent safe permissions", async () => {
    const {bot, run} = await setup();
    await (await api(`/v1/bots/${bot.id}`, {computerApprovalMode: "automatic"}, "PATCH")).text();
    const child = await created(creation(bot, run));
    expect(child).toMatchObject({
      name: "Research specialist", instructions: "Research and report your sources.",
      runtime: "pi", model: bot.model, createdByBotId: bot.id,
      allowNamedAgents: false, computerApprovalMode: "ask",
    });
    expect(child.id).not.toBe(bot.id);
    await evictDurableObject(registry());
    expect((await (await api(`/v1/bots/${child.id}`)).json<{bot: Bot}>()).bot).toEqual(child);
    const listed = await (await api("/v1/bots")).json<{bots: Bot[]}>();
    expect(listed.bots.find(value => value.id === child.id)).toEqual(child);
  });

  it("deduplicates concurrent creation and receipt retries but rejects conflicting reuse", async () => {
    const {bot, run} = await setup(), input = creation(bot, run);
    const children = await Promise.all([created(input), created(input)]);
    expect(children[0]).toEqual(children[1]);
    await evictDurableObject(registry());
    expect(await created(input)).toEqual(children[0]);
    const conflict = await coordinator({...input, name: "A different intended bot"});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({error: {code: "idempotency_conflict"}});
    const {bots} = await (await api("/v1/bots")).json<{bots: Bot[]}>();
    expect(bots.filter(value => value.createdByBotId === bot.id)).toHaveLength(1);
  });

  it("isolates the same operation ID across different creator bots", async () => {
    const first = await setup(), second = await setup(), operationId = crypto.randomUUID();
    const children = await Promise.all([
      created(creation(first.bot, first.run, operationId)),
      created(creation(second.bot, second.run, operationId)),
    ]);
    expect(children[0].id).not.toBe(children[1].id);
    expect(children.map(child => child.createdByBotId)).toEqual([first.bot.id, second.bot.id]);
  });

  it("denies creation without standing authorization and after revocation", async () => {
    const {bot, run} = await setup(false);
    const denied = await coordinator(creation(bot, run));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({error: {code: "named_agents_disabled"}});
    await api(`/v1/bots/${bot.id}`, {allowNamedAgents: true}, "PATCH");
    const child = await created(creation(bot, run));
    await api(`/v1/bots/${bot.id}`, {allowNamedAgents: false}, "PATCH");
    const revoked = await coordinator(creation(bot, run));
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({error: {code: "named_agents_disabled"}});
    expect((await api(`/v1/bots/${child.id}`)).status).toBe(200);
  });

  it("routes the model's creation tool through the same durable permission and idempotency checks", async () => {
    const {bot, run} = await setup();
    const operationId = `create-tool:${crypto.randomUUID()}`;
    const invoke = () => runInDurableObject(stubFor(bot), instance => {
      const target = instance as unknown as {executeHostTool(input: RuntimeHostToolRequest): Promise<RuntimeToolResult>};
      return target.executeHostTool({operationId, runOperationId: run.operationId, name: "create_bot", arguments: {name: "Model-created specialist", instructions: "Check the evidence."}, signal: new AbortController().signal});
    });
    const first = await invoke();
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("Expected completed creation");
    const child = JSON.parse(first.output!) as {bot: Bot};
    expect(child.bot).toMatchObject({name: "Model-created specialist", createdByBotId: bot.id, allowNamedAgents: false});
    const replay = await invoke();
    expect(replay).toEqual(first);
    const events = await runInDurableObject(stubFor(bot), (_instance, state) =>
      state.storage.sql.exec<{data: string}>("SELECT data FROM events WHERE source_key=?", `tool:${operationId}`).toArray());
    expect(events).toHaveLength(1);
  });

  it("refreshes a revoked creation permission before a model tool call without a foreground bot request", async () => {
    const {bot, run} = await setup();
    const response = await api(`/v1/bots/${bot.id}`, {allowNamedAgents: false}, "PATCH");
    expect(response.status).toBe(200);
    await response.text();
    await runInDurableObject(stubFor(bot), async (instance, state) => {
      const target = instance as unknown as {executeHostTool(input: RuntimeHostToolRequest): Promise<RuntimeToolResult>};
      const cached = JSON.parse(state.storage.sql.exec<{data: string}>("SELECT data FROM config WHERE id=1").one().data) as Bot;
      expect(cached.allowNamedAgents).toBe(true);
      await expect(target.executeHostTool({operationId: `revoked-create:${crypto.randomUUID()}`, runOperationId: run.operationId, name: "create_bot", arguments: {name: "Must not be created"}, signal: new AbortController().signal})).rejects.toMatchObject({status: 403, code: "named_agents_disabled"});
    });
    const listed = await (await api("/v1/bots")).json<{bots: Bot[]}>();
    expect(listed.bots.filter(value => value.createdByBotId === bot.id)).toHaveLength(0);
  });

  it("rechecks standing authorization after an in-flight source-run lookup", async () => {
    const {bot, run} = await setup();
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {ready = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    await runInDurableObject(stubFor(bot), instance => {
      const target = instance as unknown as {fetch(request: Request): Promise<Response>};
      const original = target.fetch.bind(target);
      target.fetch = async request => {
        if (new URL(request.url).pathname === `/runs/${run.id}`) {
          target.fetch = original;
          ready();
          await gate;
        }
        return original(request);
      };
    });
    const pending = coordinator(creation(bot, run)).then(async response => ({status: response.status, body: await response.json()}));
    await entered;
    try {
      const response = await api(`/v1/bots/${bot.id}`, {allowNamedAgents: false}, "PATCH");
      expect(response.status).toBe(200);
      await response.text();
    } finally {release();}
    const denied = await pending;
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({error: {code: "named_agents_disabled"}});
  });

  it("validates creator and run membership instead of trusting caller-supplied IDs", async () => {
    const first = await setup(), second = await setup();
    for (const patch of [
      {sourceBotId: crypto.randomUUID()},
      {sourceRunId: crypto.randomUUID()},
      {sourceRunId: second.run.id},
    ]) {
      const response = await coordinator({...creation(first.bot, first.run), ...patch});
      expect(response.status).toBe(404);
      await response.text();
    }
    for (const patch of [{sourceBotId: "not-a-uuid"}, {sourceRunId: "../runs"}, {operationId: "bad operation"}]) {
      const response = await coordinator({...creation(first.bot, first.run), ...patch});
      expect(response.status).toBe(400);
      await response.text();
    }
  });

  it("rejects new creation from cancelled runs and deleted creators", async () => {
    const {bot, run} = await setup();
    const cancelled = await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {}, "POST");
    expect(cancelled.status).toBe(200);
    await cancelled.text();
    const late = await coordinator(creation(bot, run));
    expect(late.status).toBe(409);
    await late.text();
    const deletion = await api(`/v1/bots/${bot.id}`, undefined, "DELETE");
    expect(deletion.status).toBe(200);
    await deletion.text();
    const deleted = await coordinator(creation(bot, run));
    expect(deleted.status).toBe(404);
    await deleted.text();
  });

  it("keeps coordinator creation internal and does not let public headers impersonate a bot", async () => {
    const {bot, run} = await setup(), input = creation(bot, run);
    const unmarked = await coordinator(input, false);
    expect(unmarked.status).toBe(403);
    await unmarked.text();
    for (const path of ["/v1/agents/create", `/v1/bots/${bot.id}/agents/create`]) {
      const response = await exports.default.fetch(`https://timber.test${path}`, {
        method: "POST", headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json", "x-timber-internal": "agents"},
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(404);
      await response.text();
    }
  });
});
