import { env, exports } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Approval, Bot, BotEvent, Message, Run } from "@botspace/contracts";
import {MODEL_FAILURES} from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";
import worker from "../apps/api/src/index";
import { computerFixtureControl } from "./fixtures/worker";
import { emitFixtureRuntimeEvent } from "./fixtures/runtime";

const token = "test-only-botspace-owner-token-000000";
const bindings = env as unknown as Env;
const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`https://botspace.test${path}`, {
  ...init, headers: {authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers},
});
async function createBot(name = "Ada"): Promise<Bot> {
  const response = await fetchApi("/v1/bots", {method: "POST", body: JSON.stringify({name, instructions: "Hola, programación y café ☕"})});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function submit(bot: Bot, text: string, operationId = crypto.randomUUID()): Promise<Run> {
  const response = await fetchApi(`/v1/bots/${bot.id}/messages`, {method: "POST", body: JSON.stringify({text, operationId})});
  expect(response.status).toBe(202);
  return (await response.json<{run: Run}>()).run;
}
async function waitRun(bot: Bot, run: Run, status: Run["status"]): Promise<Run> {
  let current: Run = run;
  for (let i = 0; i < 100; i++) {
    current = (await (await fetchApi(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run: Run}>()).run;
    if (current.status === status) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(current.status).toBe(status);
  return current;
}
async function getApproval(bot: Bot): Promise<Approval> {
  for (let i = 0; i < 100; i++) {
    const {approvals} = await (await fetchApi(`/v1/bots/${bot.id}/approvals`)).json<{approvals: Approval[]}>();
    if (approvals.length) return approvals[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("No approval was persisted");
}
async function effects(bot: Bot) {
  return runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)), (_instance, state) =>
    state.storage.sql.exec<{id: string; action: string}>("SELECT id,action FROM effects WHERE json_extract(action,'$.type')!='checkpoint'").toArray());
}
async function readEventBatch(path: string): Promise<BotEvent[]> {
  const response = await fetchApi(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  let text = "";
  try {
    while (!text.includes("data: ")) {
      const {value, done} = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } finally {await reader.cancel();}
  return text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as BotEvent);
}

describe("Worker authentication and durable bot identities", () => {
  it("exposes only generic health information without credentials", async () => {
    const health = await exports.default.fetch("https://botspace.test/health");
    expect(await health.json()).toEqual({ok: true, service: "botspace"});
    expect((await exports.default.fetch("https://botspace.test/v1/bots")).status).toBe(401);
  });

  it("fails closed when the deployed API secret has not been configured", async () => {
    const response = await worker.fetch(new Request("https://botspace.test/v1/bots", {headers: {authorization: `Bearer ${token}`}}), {...bindings, BOTSPACE_API_TOKEN: undefined});
    expect(response.status).toBe(503);
  });

  it("keeps named bots and Unicode configuration through an object eviction", async () => {
    const bot = await createBot("Investigación ☕");
    await evictAllDurableObjects();
    const response = await fetchApi(`/v1/bots/${bot.id}`);
    expect((await response.json<{bot: Bot}>()).bot).toEqual(bot);
    const messages = await fetchApi(`/v1/bots/${bot.id}/messages`);
    expect(messages.status).toBe(200);
  });

  it("rejects unknown bots before creating a bot object or exposing any resources", async () => {
    const unknown = crypto.randomUUID();
    for (const tail of ["", "/messages", "/computer", "/approvals", "/events", `/artifacts/${crypto.randomUUID()}`]) {
      expect((await fetchApi(`/v1/bots/${unknown}${tail}`)).status).toBe(404);
    }
  });

  it("scopes artifact access to the owning bot and makes active content an attachment", async () => {
    const first = await createBot("first"), second = await createBot("second");
    const artifactId = crypto.randomUUID();
    await bindings.FILES.put(`bots/${first.id}/artifacts/${artifactId}`, "<script>untrusted()</script>", {httpMetadata: {contentType: "text/html"}});
    expect((await fetchApi(`/v1/bots/${second.id}/artifacts/${artifactId}`)).status).toBe(404);
    const response = await fetchApi(`/v1/bots/${first.id}/artifacts/${artifactId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("durable runs and approval boundaries with deterministic external adapters", () => {
  it("classifies a native model error as failed and preserves its safe diagnostic", async () => {
    const bot = await createBot();
    const run = await submit(bot, "fixture:model-error");
    const failed = await waitRun(bot, run, "failed");
    expect(failed.error).toBe(MODEL_FAILURES.model_billing_required);
    expect(failed.errorCode).toBe("model_billing_required");
  });

  it("enriches a generic wait failure when the safe diagnostic arrives later", async () => {
    const bot = await createBot();
    const run = await submit(bot, "fixture:model-error-late");
    expect((await waitRun(bot, run, "failed")).error).toBe("The model could not complete this request.");
    await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)), async () => {
      await emitFixtureRuntimeEvent(run.operationId, "run.failed", {
        reason: "model_error", errorCode: "model_billing_required",
        publicMessage: "This model requires a paid Cloudflare Workers plan.",
      });
    });
    const enriched=await waitRun(bot,run,"failed");
    expect(enriched.error).toBe(MODEL_FAILURES.model_billing_required);
    expect(enriched.errorCode).toBe("model_billing_required");
  });

  it.each(["completed", "cancelled"] as const)("does not overwrite %s with a late model-error diagnostic", async (terminalStatus) => {
    const bot = await createBot();
    const run = await submit(bot, terminalStatus === "cancelled" ? "fixture:approval" : "successful answer");
    if (terminalStatus === "cancelled") {
      await getApproval(bot);
      const response = await fetchApi(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {method: "POST"});
      expect(response.status).toBe(200);
      await response.text();
    }
    await waitRun(bot, run, terminalStatus);
    await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)), async () => {
      await emitFixtureRuntimeEvent(run.operationId, "run.failed", {
        reason: "model_error", errorCode: "model_billing_required",
        publicMessage: "This model requires a paid Cloudflare Workers plan.",
      });
    });
    const current = await waitRun(bot, run, terminalStatus);
    expect(current.error).toBeUndefined();
    expect(current.errorCode).toBeUndefined();
  });

  it("persists only fixed model diagnostics and does not repeat an identical failure update",async()=>{
    const bot=await createBot(),run=await submit(bot,"fixture:model-error-late");await waitRun(bot,run,"failed");
    const result=await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),async(_instance,state)=>{
      const payload={reason:"model_error",errorCode:"model_fast_unsupported",publicMessage:"Untrusted provider body must never replace the fixed diagnostic."};
      await emitFixtureRuntimeEvent(run.operationId,"run.failed",payload);
      const snapshot=()=>state.storage.sql.exec<{data:string}>("SELECT data FROM events").toArray().map(row=>JSON.parse(row.data) as BotEvent);
      const first=snapshot().filter(event=>event.type==="run.updated").length;
      await emitFixtureRuntimeEvent(run.operationId,"run.failed",payload);
      return {events:snapshot(),first};
    });
    const failed=await waitRun(bot,run,"failed");expect(failed.errorCode).toBe("model_fast_unsupported");expect(failed.error).toBe(MODEL_FAILURES.model_fast_unsupported);
    expect(result.events.filter(event=>event.type==="run.updated")).toHaveLength(result.first);
    expect(JSON.stringify(result.events)).not.toContain("Untrusted provider body");
    expect(result.events.filter(event=>event.type==="run.failed").at(-1)?.data).toMatchObject({errorCode:"model_fast_unsupported",publicMessage:MODEL_FAILURES.model_fast_unsupported});
    await evictDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)));
    expect((await waitRun(bot,run,"failed")).errorCode).toBe("model_fast_unsupported");
  });

  it("deduplicates concurrent submissions and rejects reuse with different input", async () => {
    const bot = await createBot();
    const operationId = crypto.randomUUID();
    const [first, second] = await Promise.all([submit(bot, "hello", operationId), submit(bot, "hello", operationId)]);
    expect(first.id).toBe(second.id);
    await waitRun(bot, first, "completed");
    const conflict = await fetchApi(`/v1/bots/${bot.id}/messages`, {method: "POST", body: JSON.stringify({text: "different effect", operationId})});
    expect(conflict.status).toBe(409);
    const {messages} = await (await fetchApi(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
    expect(messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(messages.filter(message => message.role === "assistant")).toHaveLength(1);
  });

  it("persists the same conversation and replay result after eviction", async () => {
    const bot = await createBot();
    const run = await submit(bot, "persist me");
    await waitRun(bot, run, "completed");
    await evictDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)));
    expect((await submit(bot, "persist me", run.operationId)).id).toBe(run.id);
    const {messages} = await (await fetchApi(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
    expect(messages.map(message => message.text)).toEqual(["persist me", "Fixture answer: persist me"]);
  });

  it("does not expose another bot's run or approval through a valid bot URL", async () => {
    const first = await createBot(), second = await createBot();
    const run = await submit(first, "fixture:approval");
    const approval = await getApproval(first);
    expect((await fetchApi(`/v1/bots/${second.id}/runs/${run.id}`)).status).toBe(404);
    expect((await fetchApi(`/v1/bots/${second.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({decision: "approve"})})).status).toBe(404);
  });

  it("executes only the stored approved arguments, once, including duplicate decisions", async () => {
    const bot = await createBot();
    const run = await submit(bot, "fixture:approval");
    const approval = await getApproval(bot);
    await waitRun(bot, run, "waiting_approval");
    expect(await effects(bot)).toHaveLength(0);
    const approve = () => fetchApi(`/v1/bots/${bot.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({
      decision: "approve", action: {type: "exec", command: "THIS MUST NEVER EXECUTE"},
    })});
    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map(response => response.text()));
    await waitRun(bot, run, "completed");
    await evictDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)));
    expect((await approve()).status).toBe(200);
    const executed = await effects(bot);
    expect(executed).toHaveLength(1);
    expect(JSON.parse(executed[0].action)).toEqual({type: "exec", command: "printf original-approved-command"});
  });

  it("denial and cancellation cannot be turned into execution by a later approval", async () => {
    for (const decision of ["deny", "cancel"] as const) {
      const bot = await createBot();
      const run = await submit(bot, "fixture:approval");
      const approval = await getApproval(bot);
      if (decision === "cancel") {
        expect((await fetchApi(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {method: "POST"})).status).toBe(200);
      } else {
        expect((await fetchApi(`/v1/bots/${bot.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({decision: "deny"})})).status).toBe(200);
        await waitRun(bot, run, "completed");
      }
      await fetchApi(`/v1/bots/${bot.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({decision: "approve"})});
      expect(await effects(bot)).toHaveLength(0);
      if (decision === "cancel") await waitRun(bot, run, "cancelled");
    }
  });

  it("keeps executing after the event subscriber disconnects and resumes by durable cursor", async () => {
    const bot = await createBot();
    const run = await submit(bot, "finish after disconnect");
    const initial = await readEventBatch(`/v1/bots/${bot.id}/events`);
    expect(initial.length).toBeGreaterThan(0);
    await waitRun(bot, run, "completed");
    const cursor = initial[0].id;
    const resumed = await readEventBatch(`/v1/bots/${bot.id}/events?after=${cursor}`);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every(event => event.id > cursor && event.botId === bot.id)).toBe(true);
    expect(new Set(resumed.map(event => event.id)).size).toBe(resumed.length);
  });

  it("does not overwrite a cancellation when an already executing approval returns late", async () => {
    const bot = await createBot();
    const run = await submit(bot, "fixture:approval");
    const approval = await getApproval(bot);
    let release!: () => void;
    computerFixtureControl.gate = new Promise<void>(resolve => {release = resolve;});
    computerFixtureControl.status = "interrupted";
    try {
      const response = await fetchApi(`/v1/bots/${bot.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({decision: "approve"})});
      expect(response.status).toBe(200);
      await response.text();
      const cancellation = await fetchApi(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {method: "POST"});
      expect(cancellation.status).toBe(200);
      await cancellation.text();
      release();
      for (let i = 0; i < 100; i++) {
        const latest = await getApproval(bot);
        if (latest.status === "interrupted") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect((await getApproval(bot)).status).toBe("interrupted");
      await waitRun(bot, run, "cancelled");
    } finally {
      release();
      delete computerFixtureControl.gate;
      delete computerFixtureControl.status;
    }
  });

  it("invalidates a stale GUI approval after manual input but preserves it after a read", async () => {
    const bot = await createBot();
    const run = await submit(bot, "fixture:gui-approval");
    const approval = await getApproval(bot);
    await waitRun(bot, run, "waiting_approval");
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBeLessThanOrEqual(5 * 60_000);
    const read = await fetchApi(`/v1/bots/${bot.id}/computer/actions`, {method: "POST", body: JSON.stringify({operationId: "human-read", action: {type: "listFiles"}})});
    expect(read.status).toBe(200);
    await read.text();
    expect((await getApproval(bot)).status).toBe("pending");
    const input = await fetchApi(`/v1/bots/${bot.id}/computer/actions`, {method: "POST", body: JSON.stringify({operationId: "human-key", action: {type: "key", key: "Escape"}})});
    expect(input.status).toBe(200);
    await input.text();
    expect((await getApproval(bot)).status).toBe("interrupted");
    const response = await fetchApi(`/v1/bots/${bot.id}/approvals/${approval.id}`, {method: "POST", body: JSON.stringify({decision: "approve"})});
    await response.text();
    expect((await effects(bot)).map(effect => JSON.parse(effect.action).type)).toEqual(["listFiles", "key"]);
    await waitRun(bot, run, "interrupted");
  });
});
