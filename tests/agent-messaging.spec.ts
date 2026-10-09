import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDelegation, Bot, Message, Run } from "@botspace/contracts";
import type { AgentRuntime } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown, method?: string) => exports.default.fetch(`https://timber.test${path}`, {
  method: method ?? (body === undefined ? "GET" : "POST"),
  headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const registry = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const coordinator = (body: object) => registry().fetch("https://workspace/agents/send", {
  method: "POST", headers: {"content-type": "application/json", "x-timber-internal": "agents"}, body: JSON.stringify(body),
});
async function create(): Promise<Bot> {
  const response = await api("/v1/bots", {name: `Collaborator ${crypto.randomUUID()}`});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function current(bot: Bot, id: string): Promise<Run> {
  return (await (await api(`/v1/bots/${bot.id}/runs/${id}`)).json<{run: Run}>()).run;
}
async function source(): Promise<{bot: Bot; run: Run}> {
  const bot = await create();
  const response = await api(`/v1/bots/${bot.id}/messages`, {text: "fixture:approval", operationId: crypto.randomUUID()});
  expect(response.status).toBe(202);
  const {run} = await response.json<{run: Run}>();
  await until(() => current(bot, run.id), value => value.status === "waiting_approval");
  return {bot, run};
}
async function hold(bot: Bot): Promise<void> {
  await api(`/v1/bots/${bot.id}/messages`);
  await runInDurableObject(stubFor(bot), instance => {
    const target = instance as unknown as {runtime: AgentRuntime};
    target.runtime = {...target.runtime, submit: async () => {throw new Error("Fixture admission remains unavailable");}};
  });
}
async function messages(bot: Bot): Promise<Message[]> {
  return (await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>()).messages;
}
async function tasks(bot: Bot): Promise<AgentDelegation[]> {
  const response = await api(`/v1/bots/${bot.id}/delegations`);
  expect(response.status).toBe(200);
  return (await response.json<{delegations: AgentDelegation[]}>()).delegations;
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !accept(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    value = await read();
  }
  expect(accept(value)).toBe(true);
  return value;
}
const input = (bot: Bot, run: Run, target: Bot, text = "Please investigate this task", operationId = crypto.randomUUID()) => ({sourceBotId: bot.id, sourceRunId: run.id, targetBotId: target.id, text, operationId});
async function send(value: object): Promise<AgentDelegation> {
  const response = await coordinator(value);
  expect(response.status).toBe(202);
  return (await response.json<{delegation: AgentDelegation}>()).delegation;
}
async function advance(id: string): Promise<void> {
  await runInDurableObject(registry(), async (instance, state) => {
    state.storage.sql.exec("UPDATE agent_deliveries SET next_at=0 WHERE id=? AND phase!='done'", id);
    await (instance as unknown as {alarm(): Promise<void>}).alarm();
  });
}
async function delivered(bot: Bot, delegation: AgentDelegation): Promise<AgentDelegation> {
  const list = await until(() => tasks(bot), values => !!values.find(value => value.id === delegation.id)?.targetRunId);
  return list.find(value => value.id === delegation.id)!;
}

describe("durable communication between named bots", () => {
  it("delivers once with trusted provenance, source lineage, and an independently visible target run", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    const delegation = await send(input(bot, run, target));
    const accepted = await delivered(bot, delegation);
    expect(accepted).toMatchObject({sourceBotId: bot.id, sourceRunId: run.id, targetBotId: target.id, path: [bot.id, target.id], status: "queued"});
    const targetRun = await current(target, accepted.targetRunId!);
    expect(targetRun.delegation).toEqual({id: delegation.id, sourceBotId: bot.id, sourceRunId: run.id, path: [bot.id, target.id]});
    expect(await messages(target)).toEqual([expect.objectContaining({
      text: "Please investigate this task", runId: targetRun.id,
      provenance: {kind: "bot", sourceBotId: bot.id, sourceBotName: bot.name, sourceRunId: run.id, delegationId: delegation.id},
    })]);
    expect((await tasks(target)).map(value => value.id)).toContain(delegation.id);
    const outsider = await create();
    expect(await tasks(outsider)).toEqual([]);
    expect((await api(`/v1/bots/${outsider.id}/runs/${targetRun.id}`)).status).toBe(404);
  });

  it("deduplicates concurrent requests and eviction retries while rejecting changed text or targets", async () => {
    const {bot, run} = await source(), target = await create(), other = await create();
    await hold(target);
    const request = input(bot, run, target);
    const [first, second] = await Promise.all([send(request), send(request)]);
    expect(first.id).toBe(second.id);
    await delivered(bot, first);
    await evictDurableObject(registry());
    expect((await send(request)).id).toBe(first.id);
    for (const patch of [{text: "Different delegated task"}, {targetBotId: other.id}]) {
      const conflict = await coordinator({...request, ...patch});
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({error: {code: "idempotency_conflict"}});
    }
    expect((await messages(target)).filter(message => message.provenance?.delegationId === first.id)).toHaveLength(1);
    expect(await messages(other)).toHaveLength(0);
    expect(await tasks(bot)).toHaveLength(1);
  });

  it("reconciles a lost target receipt by replaying the same durable input without duplicating messages", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    let receipts = 0;
    await runInDurableObject(stubFor(target), instance => {
      const object = instance as unknown as {fetch(request: Request): Promise<Response>};
      const original = object.fetch.bind(object);
      object.fetch = async request => {
        const response = await original(request);
        if (new URL(request.url).pathname === "/agent-messages" && ++receipts === 1) {
          await response.text();
          return new Response("Lost delivery receipt", {status: 503});
        }
        return response;
      };
    });
    const delegation = await send(input(bot, run, target));
    await until(() => messages(target), values => values.some(value => value.provenance?.delegationId === delegation.id));
    await advance(delegation.id);
    const accepted = await delivered(bot, delegation);
    expect(receipts).toBe(2);
    expect((await messages(target)).filter(message => message.provenance?.delegationId === delegation.id)).toHaveLength(1);
    const targetRuns = await (await api(`/v1/bots/${target.id}/runs`)).json<{runs: Run[]}>();
    expect(targetRuns.runs.filter(value => value.operationId === `delegate:${delegation.id}`)).toHaveLength(1);
    expect(accepted.targetRunId).toBe(targetRuns.runs[0].id);
  });

  it("returns a completed result once and preserves result attribution across receipt loss", async () => {
    const {bot, run} = await source(), target = await create();
    let results = 0;
    await runInDurableObject(stubFor(bot), instance => {
      const object = instance as unknown as {fetch(request: Request): Promise<Response>};
      const original = object.fetch.bind(object);
      object.fetch = async request => {
        const response = await original(request);
        if (new URL(request.url).pathname === "/agent-results" && ++results === 1) {
          await response.text();
          return new Response("Lost result acknowledgement", {status: 503});
        }
        return response;
      };
    });
    const delegation = await send(input(bot, run, target, "Summarize the evidence"));
    const accepted = await delivered(bot, delegation);
    await until(() => current(target, accepted.targetRunId!), value => value.status === "completed");
    for (let attempt = 0; attempt < 4; attempt++) await advance(delegation.id);
    const incoming = (await messages(bot)).filter(message => message.provenance?.delegationId === delegation.id);
    expect(results).toBeGreaterThanOrEqual(2);
    expect(results).toBeLessThanOrEqual(5);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({provenance: {kind: "delegation_result", sourceBotId: target.id, sourceBotName: target.name, sourceRunId: accepted.targetRunId, delegationId: delegation.id}});
    const targetAnswer = (await messages(target)).find(message => message.runId === accepted.targetRunId && message.role === "assistant")!;
    expect(incoming[0].text).toBe(targetAnswer.text);
    expect(incoming[0].text).toContain("Summarize the evidence");
    const runs = await (await api(`/v1/bots/${bot.id}/runs`)).json<{runs: Run[]}>();
    expect(runs.runs.filter(value => value.operationId === `agent-result:${delegation.id}`)).toHaveLength(1);
    const finishedCalls = results;
    await advance(delegation.id);
    expect(results).toBe(finishedCalls);
  });

  it("rejects cycles and limits lineage to four delegated hops", async () => {
    const initial = await source(), chain = [initial.bot];
    let bot = initial.bot, run = initial.run;
    for (let hop = 0; hop < 4; hop++) {
      const target = await create();
      await hold(target);
      const next = await delivered(bot, await send(input(bot, run, target)));
      chain.push(target);
      expect(next.path).toEqual(chain.map(value => value.id));
      bot = target;
      run = await current(target, next.targetRunId!);
    }
    const cycle = await coordinator(input(bot, run, initial.bot));
    expect(cycle.status).toBe(409);
    expect(await cycle.json()).toMatchObject({error: {code: "delegation_cycle"}});
    const target = await create();
    const deep = await coordinator(input(bot, run, target));
    expect(deep.status).toBe(409);
    expect(await deep.json()).toMatchObject({error: {code: "delegation_depth"}});
    expect(await messages(target)).toHaveLength(0);
  });

  it("limits pending delegations without treating an idempotent replay as another task", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    const first = input(bot, run, target);
    const accepted = await send(first);
    for (let task = 1; task < 8; task++) await send(input(bot, run, target));
    expect((await send(first)).id).toBe(accepted.id);
    const ninth = await coordinator(input(bot, run, target));
    expect(ninth.status).toBe(429);
    expect(await ninth.json()).toMatchObject({error: {code: "delegation_limit"}});
    expect(await tasks(bot)).toHaveLength(8);
  });

  it("cancels delegated work and prevents result continuations after its source is cancelled", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    const delegation = await delivered(bot, await send(input(bot, run, target)));
    const cancelled = await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await cancelled.text();
    for (let attempt = 0; attempt < 3; attempt++) await advance(delegation.id);
    expect((await current(target, delegation.targetRunId!)).status).toBe("cancelled");
    expect((await current(bot, run.id)).status).toBe("cancelled");
    const late = await coordinator(input(bot, run, target));
    expect(late.status).toBe(409);
    await late.text();
    const sourceRuns = await (await api(`/v1/bots/${bot.id}/runs`)).json<{runs: Run[]}>();
    expect(sourceRuns.runs.filter(value => value.operationId === `agent-result:${delegation.id}`)).toHaveLength(0);
  });

  it("turns recipient deletion into a visible terminal result without recreating its bot", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    const request = input(bot, run, target), delegation = await delivered(bot, await send(request));
    const deletion = await api(`/v1/bots/${target.id}`, undefined, "DELETE");
    expect(deletion.status).toBe(200);
    await deletion.text();
    for (let attempt = 0; attempt < 3; attempt++) await advance(delegation.id);
    expect((await tasks(bot)).find(value => value.id === delegation.id)).toMatchObject({status: "failed", error: expect.any(String)});
    expect((await messages(bot)).some(message => message.provenance?.delegationId === delegation.id)).toBe(true);
    expect((await send(request)).id).toBe(delegation.id);
    expect((await api(`/v1/bots/${target.id}`)).status).toBe(404);
  });

  it("fences a late initial delivery after cancellation even when no target receipt ever existed", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    let pendingBody: Record<string, unknown> | undefined;
    await runInDurableObject(stubFor(target), instance => {
      const object = instance as unknown as {fetch(request: Request): Promise<Response>};
      const original = object.fetch.bind(object);
      object.fetch = async request => {
        if (new URL(request.url).pathname === "/agent-messages") {
          pendingBody = await request.json<Record<string, unknown>>();
          object.fetch = original;
          return new Response("The message has not arrived", {status: 503});
        }
        return original(request);
      };
    });
    const delegation = await send(input(bot, run, target));
    await until(async () => pendingBody, value => value !== undefined);
    await (await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {})).text();
    for (let attempt = 0; attempt < 3; attempt++) await advance(delegation.id);
    const late = await stubFor(target).fetch("https://bot/agent-messages", {
      method: "POST", headers: {"content-type": "application/json", "x-timber-internal": "agents", "x-botspace-config": encodeURIComponent(JSON.stringify(target))},
      body: JSON.stringify(pendingBody),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({error: {code: "run_cancelled"}});
    expect(await messages(target)).toHaveLength(0);
  });

  it("cancels outstanding work when the source bot is deleted and erases its outbox payload", async () => {
    const {bot, run} = await source(), target = await create();
    await hold(target);
    const delegation = await delivered(bot, await send(input(bot, run, target, "Private task that must be scrubbed")));
    const deletion = await api(`/v1/bots/${bot.id}`, undefined, "DELETE");
    expect(deletion.status).toBe(200);
    await deletion.text();
    for (let attempt = 0; attempt < 3; attempt++) await advance(delegation.id);
    expect((await current(target, delegation.targetRunId!)).status).toBe("cancelled");
    const retained = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec<{data: string}>("SELECT data FROM agent_deliveries WHERE source_bot_id=?", bot.id).toArray());
    expect(retained).toHaveLength(0);
    expect((await api(`/v1/bots/${bot.id}`)).status).toBe(404);
  });
});
