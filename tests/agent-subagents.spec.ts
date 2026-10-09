import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Approval, Bot, Message, Run, Subagent } from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";
import type { AgentRuntime } from "../packages/runtime/src/types";

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown, method?: string) => exports.default.fetch(`https://timber.test${path}`, {
  method: method ?? (body === undefined ? "GET" : "POST"),
  headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function agents(bot: Bot): Promise<Subagent[]> {
  const response = await api(`/v1/bots/${bot.id}/agents`);
  expect(response.status).toBe(200);
  return (await response.json<{agents: Subagent[]}>()).agents;
}
async function current(bot: Bot, run: Run): Promise<Run> {
  return (await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run: Run}>()).run;
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !accept(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    value = await read();
  }
  expect(accept(value)).toBe(true);
  return value;
}
async function setup(): Promise<{bot: Bot; parent: Run; child: Subagent; approval: Approval; childRun: Run}> {
  const {bot} = await (await api("/v1/bots", {name: "Temporary agent parent"})).json<{bot: Bot}>();
  const response = await api(`/v1/bots/${bot.id}/messages`, {text: "fixture:subagent-approval", operationId: crypto.randomUUID()});
  expect(response.status).toBe(202);
  const {run: parent} = await response.json<{run: Run}>();
  const children = await eventually(() => agents(bot), values => values.some(child => child.status === "waiting_approval"));
  await eventually(() => current(bot, parent), value => value.status === "completed");
  const {approvals} = await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals: Approval[]}>();
  const {runs} = await (await api(`/v1/bots/${bot.id}/runs`)).json<{runs: Run[]}>();
  const child = children[0], childRun = runs.find(run => run.subagentId === child.id)!;
  expect(childRun).toBeDefined();
  const approval = approvals.find(value => value.runId === childRun.id)!;
  expect(approval).toBeDefined();
  return {bot, parent, child, approval, childRun};
}

describe("temporary subagent host projection and approval routing", () => {
  it("lists a durable child with its own active host run after the parent has answered", async () => {
    const {bot, parent, child, approval, childRun} = await setup();
    expect(child).toMatchObject({name: "Temporary researcher", parentOperationId: parent.operationId, status: "waiting_approval"});
    expect(childRun).toMatchObject({parentRunId: parent.id, subagentId: child.id, status: "waiting_approval"});
    expect(approval.runId).not.toBe(parent.id);
    expect((await current(bot, parent)).status).toBe("completed");
    await evictDurableObject(stubFor(bot));
    expect(await agents(bot)).toEqual([child]);
    expect((await current(bot, childRun)).status).toBe("waiting_approval");
    const listed = await (await api("/v1/bots")).json<{bots: Bot[]}>();
    expect(listed.bots.some(value => value.id === child.id)).toBe(false);
  });

  it("executes a child approval once and routes its durable continuation to that child", async () => {
    const {bot, parent, child, approval, childRun} = await setup();
    const approve = () => api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"});
    const decisions = await Promise.all([approve(), approve()]);
    expect(decisions.map(response => response.status)).toEqual([200, 200]);
    await Promise.all(decisions.map(response => response.text()));
    await eventually(() => agents(bot), values => values[0]?.status === "completed");
    expect((await current(bot, parent)).status).toBe("completed");
    expect((await current(bot, childRun)).status).toBe("completed");
    const effects = await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)), (_instance, state) =>
      state.storage.sql.exec<{action: string}>("SELECT action FROM effects WHERE json_extract(action,'$.type')='exec'").toArray());
    expect(effects.map(value => JSON.parse(value.action))).toEqual([{type: "exec", command: "printf child-approved-command"}]);
    const receipt = await runInDurableObject(stubFor(bot), async (_instance, state) => {
      const inputs = await state.storage.list<string>({prefix: `fixture-subagent-input:${child.id}:`});
      const submissions = state.storage.sql.exec<{subagent_id: string}>("SELECT subagent_id FROM submissions WHERE operation_id LIKE 'approval:%'").toArray();
      return {inputs: [...inputs.keys()], submissions};
    });
    expect(receipt.inputs).toHaveLength(1);
    expect(receipt.submissions).toEqual([{subagent_id: child.id}]);
    const messages = await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
    expect(messages.messages.filter(value => value.runId === parent.id && value.role === "assistant")).toHaveLength(1);
    const childMessages = await (await api(`/v1/bots/${bot.id}/agents/${child.id}/messages`)).json<{messages: Message[]}>();
    expect(childMessages.messages).toHaveLength(1);
    expect(childMessages.messages[0].text).toContain("Fixture child answer:");
  });

  it("isolates child transcript and cancellation routes by parent bot membership", async () => {
    const {bot, child} = await setup();
    const {bot: other} = await (await api("/v1/bots", {name: "Unrelated parent"})).json<{bot: Bot}>();
    expect(await agents(other)).toEqual([]);
    for (const tail of ["messages", "cancel"]) {
      const response = await api(`/v1/bots/${other.id}/agents/${child.id}/${tail}`, tail === "cancel" ? {} : undefined);
      expect(response.status).toBe(404);
      await response.text();
      const unauthorized = await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/agents/${child.id}/${tail}`, {method: tail === "cancel" ? "POST" : "GET"});
      expect(unauthorized.status).toBe(401);
      await unauthorized.text();
    }
    expect((await agents(bot))[0].status).toBe("waiting_approval");
  });

  it("cancels a background child and makes its old approval inert", async () => {
    const {bot, child, approval, childRun, parent} = await setup();
    const response = await api(`/v1/bots/${bot.id}/agents/${child.id}/cancel`, {});
    expect(response.status).toBe(200);
    expect((await response.json<{agent: Subagent}>()).agent.status).toBe("cancelled");
    expect((await current(bot, childRun)).status).toBe("cancelled");
    expect((await current(bot, parent)).status).toBe("completed");
    await (await api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"})).text();
    const effects = await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)), (_instance, state) =>
      state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM effects WHERE json_extract(action,'$.type')='exec'").one().count);
    expect(effects).toBe(0);
    expect((await agents(bot))[0].status).toBe("cancelled");
  });

  it("cancels unfinished children when stopping a parent that already returned its first answer", async () => {
    const {bot, parent, childRun, approval} = await setup();
    const cancelled = await api(`/v1/bots/${bot.id}/runs/${parent.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json<{run: Run}>()).run.status).toBe("cancelled");
    expect((await current(bot, childRun)).status).toBe("cancelled");
    expect((await agents(bot))[0].status).toBe("cancelled");
    await (await api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"})).text();
    const effects = await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)), (_instance, state) =>
      state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM effects WHERE json_extract(action,'$.type')='exec'").one().count);
    expect(effects).toBe(0);
  });

  it.each(["owner", "native"] as const)("fences every pending child input when %s cancellation stops the subagent", async mode => {
    const {bot, parent, child, approval: firstApproval, childRun: firstRun} = await setup();
    const operationId = crypto.randomUUID();
    const submitted = await api(`/v1/bots/${bot.id}/agents/${child.id}/messages`, {operationId, text: "fixture:subagent-approval"});
    expect(submitted.status).toBe(202);
    await submitted.text();
    const approvals = await eventually(async () => (await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals: Approval[]}>()).approvals,
      values => values.filter(value => value.status === "pending").length === 2);
    const {runs: before} = await (await api(`/v1/bots/${bot.id}/runs`)).json<{runs: Run[]}>();
    const childRuns = before.filter(run => run.subagentId === child.id);
    expect(childRuns).toHaveLength(2);
    expect(childRuns.every(run => run.status === "waiting_approval" && run.parentRunId === parent.id)).toBe(true);
    expect(childRuns.some(run => run.id === firstRun.id)).toBe(true);
    expect(approvals.some(value => value.id === firstApproval.id)).toBe(true);
    if (mode === "owner") {
      const cancelled = await api(`/v1/bots/${bot.id}/agents/${child.id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      await cancelled.text();
    } else {
      await runInDurableObject(stubFor(bot), async instance => {
        const target = instance as unknown as {runtime: AgentRuntime};
        expect(await target.runtime.cancelSubagent(child.id)).toBe(true);
      });
    }
    for (const run of childRuns) expect((await current(bot, run)).status).toBe("cancelled");
    for (const approval of approvals) await (await api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"})).text();
    const effects = await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)), (_instance, state) =>
      state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM effects WHERE json_extract(action,'$.type')='exec'").one().count);
    expect(effects).toBe(0);
    expect((await agents(bot))[0].status).toBe("cancelled");
    expect((await current(bot, parent)).status).toBe("completed");
  });
});
