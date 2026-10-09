import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run, Subagent } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown) => exports.default.fetch(`https://timber.test${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 300 && !accept(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    value = await read();
  }
  expect(value, "Production BotDO and native Pi did not reach the expected state").toSatisfy(accept);
  return value;
}
const agents = async (bot: Bot) => (await (await api(`/v1/bots/${bot.id}/agents`)).json<{agents: Subagent[]}>()).agents;
const run = async (bot: Bot, id: string) => (await (await api(`/v1/bots/${bot.id}/runs/${id}`)).json<{run: Run}>()).run;
const runs = async (bot: Bot) => (await (await api(`/v1/bots/${bot.id}/runs`)).json<{runs: Run[]; activeRuns: Run[]}>());

it("integrates native Pi child spawning, independent parent completion, child approval continuation and automatic parent reporting", async () => {
  const created = await api("/v1/bots", {name: "Native child integration", computerApprovalMode: "ask"});
  expect(created.status).toBe(201);
  const {bot} = await created.json<{bot: Bot}>();
  const submitted = await api(`/v1/bots/${bot.id}/messages`, {text: "request-native-subagent", operationId: crypto.randomUUID()});
  expect(submitted.status).toBe(202);
  const {run: parent} = await submitted.json<{run: Run}>();
  const [child] = await until(() => agents(bot), values => values[0]?.status === "waiting_approval");
  await until(() => run(bot, parent.id), value => value.status === "completed");
  expect(child).toMatchObject({name: "Native researcher", parentOperationId: parent.operationId, task: "request-native-child-exec"});
  const before = await runs(bot);
  const childRun = before.runs.find(value => value.subagentId === child.id)!;
  expect(childRun).toMatchObject({parentRunId: parent.id, status: "waiting_approval"});
  expect(before.activeRuns.map(value => value.id)).toContain(childRun.id);
  const {approvals} = await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals: Approval[]}>();
  expect(approvals).toHaveLength(1);
  const approval = approvals[0];
  expect(approval).toMatchObject({runId: childRun.id, status: "pending", action: {type: "exec", command: "printf native-child-command"}});
  const computer = bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer, (_instance, state) => state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM effects").one().count)).toBe(0);
  const decisions = await Promise.all([
    api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"}),
    api(`/v1/bots/${bot.id}/approvals/${approval.id}`, {decision: "approve"}),
  ]);
  expect(decisions.map(response => response.status)).toEqual([200, 200]);
  await Promise.all(decisions.map(response => response.text()));
  await until(() => agents(bot), values => values[0]?.status === "completed");
  const reported = await until(() => runs(bot), value => value.runs.some(item => item.operationId.startsWith("subagent-report:") && item.status === "completed"));
  expect(reported.runs.filter(value => value.operationId.startsWith("subagent-report:"))).toHaveLength(1);
  expect(reported.activeRuns).toEqual([]);
  expect((await run(bot, parent.id)).status).toBe("completed");
  expect((await run(bot, childRun.id)).status).toBe("completed");
  const effects = await runInDurableObject(computer, (_instance, state) => state.storage.sql.exec<{action: string}>("SELECT action FROM effects").toArray());
  expect(effects.map(value => JSON.parse(value.action))).toEqual([expect.objectContaining({type: "exec", command: "printf native-child-command"})]);
  const {messages: childMessages} = await (await api(`/v1/bots/${bot.id}/agents/${child.id}/messages`)).json<{messages: Message[]}>();
  expect(childMessages.filter(value => value.role === "user")).toHaveLength(2);
  expect(childMessages.filter(value => value.role === "assistant").at(-1)?.text).toBe("Hello from ChatGPT via the real Pi harness.");
  const {messages} = await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
  expect(messages.filter(value => value.runId === parent.id && value.role === "assistant").map(value => value.text)).toEqual(["I delegated the command to Native researcher."]);
  const reportEvents = await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)), (_instance, state) =>
    state.storage.sql.exec<{data: string}>("SELECT data FROM events WHERE json_extract(data,'$.type')='subagent.reported'").toArray().map(value => JSON.parse(value.data).data));
  expect(reportEvents).toEqual([expect.objectContaining({subagentId:child.id,subagentName:"Native researcher",contentFormat:"plain",kind:"result",text:"Hello from ChatGPT via the real Pi harness."})]);
  const stored = await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)), (_instance, state) =>
    state.storage.sql.exec<{subagent_id: string}>("SELECT subagent_id FROM submissions WHERE operation_id=?", `approval:${approval.id}`).toArray());
  expect(stored).toEqual([{subagent_id: child.id}]);
});
