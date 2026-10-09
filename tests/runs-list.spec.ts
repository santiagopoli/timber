import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bot, Run, RunStatus } from "@botspace/contracts";
import {MODEL_FAILURES} from "@botspace/contracts";
import type {AgentRuntime} from "../packages/runtime/src/types";

interface Page {runs: Run[]; activeRuns: Run[]; nextCursor: string | null;}
const bindings = env as unknown as {BOT: DurableObjectNamespace};
const headers = {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"};
const api = (path: string, init: RequestInit = {}) => exports.default.fetch(`https://timber.test${path}`, {...init, headers});
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));

async function createBot(): Promise<Bot> {
  const response = await api("/v1/bots", {method: "POST", body: JSON.stringify({name: `runs-${crypto.randomUUID()}`})});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
async function page(bot: Bot, query = ""): Promise<Page> {
  const response = await api(`/v1/bots/${bot.id}/runs${query}`);
  expect(response.status).toBe(200);
  return response.json<Page>();
}
async function seed(bot: Bot, statuses: RunStatus[]): Promise<Run[]> {
  const runs = statuses.map(status => {
    const id = crypto.randomUUID();
    return {id, botId: bot.id, operationId: `seed-${id}`, status,
      // Identical timestamps ensure ordering and pagination do not depend on
      // clock precision, UUID order, or the timestamp of a later status update.
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"} satisfies Run;
  });
  await runInDurableObject(stubFor(bot), (_instance, state) => {
    for (const run of runs) state.storage.sql.exec(
      "INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",
      run.id, run.operationId, "seeded-history", run.operationId, JSON.stringify(run),
    );
  });
  return runs;
}

describe("durable bot run history", () => {
  it('reveals the saved subscription failure in list and detail views without rewriting or retrying historical work',async()=>{
    const bot=await createBot();
    const [run]=await seed(bot,['failed']);
    const historical={...run,errorCode:'model_request_failed',error:MODEL_FAILURES.model_request_failed};
    await runInDurableObject(stubFor(bot),(instance,state)=>{
      state.storage.sql.exec('UPDATE runs SET native_operation_id=?,data=? WHERE id=?','native-continuation',JSON.stringify(historical),run.id);
      const runtime=(instance as unknown as {runtime:AgentRuntime}).runtime;
      runtime.failureDiagnostic=operationId=>{
        expect(operationId).toBe('native-continuation');
        return {errorCode:'chatgpt_allowance_exhausted',publicMessage:'PRIVATE_PROVIDER_CANARY'};
      };
      runtime.submit=async()=>{throw new Error('History must never resubmit input');};
    });
    const expected={...historical,errorCode:'chatgpt_allowance_exhausted',error:MODEL_FAILURES.chatgpt_allowance_exhausted};
    expect((await page(bot)).runs).toEqual([expected]);
    expect(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json()).toEqual({run:expected});
    await runInDurableObject(stubFor(bot),(_instance,state)=>{
      expect(JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',run.id).toArray()[0].data)).toEqual(historical);
      expect(state.storage.sql.exec('SELECT id FROM messages').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT id FROM events').toArray()).toHaveLength(0);
    });
  });

  it('does not replace cancelled, successful, or already specific failures with a historical quota diagnostic',async()=>{
    const bot=await createBot();
    const runs=await seed(bot,['cancelled','completed','failed','failed']);
    const expected=runs.map((run,index)=>index===2?{...run,error:'Tool action failed.'}:index===3?{...run,errorCode:'model_fast_unsupported',error:MODEL_FAILURES.model_fast_unsupported}:run);
    await runInDurableObject(stubFor(bot),(instance,state)=>{
      for(const run of expected)state.storage.sql.exec('UPDATE runs SET data=? WHERE id=?',JSON.stringify(run),run.id);
      (instance as unknown as {runtime:AgentRuntime}).runtime.failureDiagnostic=()=>{throw new Error('Specific outcomes must not be reclassified');};
    });
    expect((await page(bot)).runs).toEqual(expected.slice().reverse());
  });

  it("requires authentication and registry membership before exposing history", async () => {
    const bot = await createBot();
    await seed(bot, ["completed"]);
    const unauthenticated = await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/runs`);
    expect(unauthenticated.status).toBe(401); await unauthenticated.text();
    const unknown = await api(`/v1/bots/${crypto.randomUUID()}/runs`);
    expect(unknown.status).toBe(404); await unknown.text();
  });

  it("returns an empty history with no misleading next cursor", async () => {
    expect(await page(await createBot())).toEqual({runs: [], activeRuns: [], nextCursor: null});
  });

  it("defaults to 30 newest runs and supports the documented 100-item maximum", async () => {
    const bot = await createBot();
    const runs = await seed(bot, Array.from({length: 105}, () => "completed" as const));
    const normal = await page(bot);
    expect(normal.runs.map(run => run.id)).toEqual(runs.slice(-30).reverse().map(run => run.id));
    expect(normal.nextCursor).toMatch(/^[1-9]\d*$/);
    const maximum = await page(bot, "?limit=100");
    expect(maximum.runs).toHaveLength(100);
    const remaining = await page(bot, `?limit=100&before=${maximum.nextCursor}`);
    expect(remaining.runs.map(run => run.id)).toEqual(runs.slice(0, 5).reverse().map(run => run.id));
    expect(remaining.nextCursor).toBeNull();
  });

  it("rejects invalid bounds and cursors rather than silently changing the query", async () => {
    const bot = await createBot();
    const queries = [
      "limit=", "limit=0", "limit=-1", "limit=101", "limit=1.5", "limit=1e2", "limit=hello",
      "before=", "before=0", "before=-1", "before=1.5", "before=1e3", "before=Infinity", "before=9007199254740992",
    ];
    for (const query of queries) {
      const response = await api(`/v1/bots/${bot.id}/runs?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({error: {code: expect.any(String), message: expect.any(String)}});
    }
  });

  it("paginates without duplicates or omissions when newer runs arrive and old statuses change", async () => {
    const bot = await createBot();
    const original = await seed(bot, Array.from({length: 7}, () => "completed" as const));
    const first = await page(bot, "?limit=3");
    const [newer] = await seed(bot, ["completed"]);
    const changed = {...original[0], status: "failed" as const, updatedAt: "2099-01-01T00:00:00.000Z", error: "historical update"};
    await runInDurableObject(stubFor(bot), (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?", JSON.stringify(changed), changed.id);
    });
    const second = await page(bot, `?limit=3&before=${first.nextCursor}`);
    const third = await page(bot, `?limit=3&before=${second.nextCursor}`);
    const combined = [...first.runs, ...second.runs, ...third.runs];
    expect(combined.map(run => run.id)).toEqual(original.slice().reverse().map(run => run.id));
    expect(new Set(combined.map(run => run.id)).size).toBe(7);
    expect(combined.at(-1)).toEqual(changed);
    expect(third.nextCursor).toBeNull();
    expect((await page(bot, "?limit=1")).runs[0].id).toBe(newer.id);
  });

  it("includes active runs independently of the history page and allows deliberate overlap", async () => {
    const bot = await createBot();
    const active = await seed(bot, ["queued", "running", "waiting_approval"]);
    const finished = await seed(bot, ["completed", "failed", "cancelled", "interrupted"]);
    const first = await page(bot, "?limit=2");
    expect(first.runs.map(run => run.id)).toEqual(finished.slice(-2).reverse().map(run => run.id));
    expect(first.activeRuns.map(run => run.id)).toEqual(active.slice().reverse().map(run => run.id));
    const emptyHistory = await page(bot, "?before=1&limit=1");
    expect(emptyHistory.runs).toEqual([]);
    expect(emptyHistory.nextCursor).toBeNull();
    expect(emptyHistory.activeRuns).toEqual(first.activeRuns);
    const full = await page(bot, "?limit=100");
    expect(full.activeRuns.every(run => full.runs.some(item => item.id === run.id))).toBe(true);
  });

  it("keeps pagination and active state isolated to each named bot", async () => {
    const firstBot = await createBot(), secondBot = await createBot();
    await seed(firstBot, ["waiting_approval", "completed", "completed"]);
    const ownRuns = await seed(secondBot, ["queued", "completed"]);
    const foreignCursor = (await page(firstBot, "?limit=1")).nextCursor;
    const result = await page(secondBot, `?before=${foreignCursor}`);
    expect(result.runs.map(run => run.id)).toEqual(ownRuns.slice().reverse().map(run => run.id));
    expect([...result.runs, ...result.activeRuns].every(run => run.botId === secondBot.id)).toBe(true);
    expect(result.activeRuns.map(run => run.id)).toEqual([ownRuns[0].id]);
  });

  it("preserves a cursor and pending work when the bot object is evicted", async () => {
    const bot = await createBot();
    const original = await seed(bot, ["waiting_approval", "completed", "completed", "failed"]);
    const first = await page(bot, "?limit=2");
    await evictDurableObject(stubFor(bot));
    const remaining = await page(bot, `?limit=2&before=${first.nextCursor}`);
    expect(remaining.runs.map(run => run.id)).toEqual(original.slice(0, 2).reverse().map(run => run.id));
    expect(remaining.activeRuns).toEqual(first.activeRuns);
    expect(remaining.nextCursor).toBeNull();
  });
});
