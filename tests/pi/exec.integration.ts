import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { Bot, BotEvent, ComputerAction, Message, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";
import { computerFixtureControl } from "../fixtures/worker";

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown) => exports.default.fetch(`https://timber.test${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: {authorization: "Bearer test-only-botspace-owner-token-000000", "content-type": "application/json"},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
afterEach(() => { delete computerFixtureControl.execSession; });

for (const cancel of [false, true]) it(`native Pi starts a process once and ${cancel ? "cancels" : "polls"} it through the host`, async () => {
  computerFixtureControl.execSession = {pollsBeforeComplete: 0};
  const {bot} = await (await api("/v1/bots", {name: "Native process integration", computerApprovalMode: "automatic"})).json<{bot: Bot}>();
  const operationId = crypto.randomUUID();
  const input = {text: `request-native-exec-session${cancel ? " cancel-process" : ""}`, operationId};
  const {run: initial} = await (await api(`/v1/bots/${bot.id}/messages`, input)).json<{run: Run}>();
  let current = initial;
  for (let attempt = 0; attempt < 300 && !["completed", "failed", "interrupted"].includes(current.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    current = (await (await api(`/v1/bots/${bot.id}/runs/${initial.id}`)).json<{run: Run}>()).run;
  }
  expect(current.status, JSON.stringify(current)).toBe("completed");
  const computer = bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  const effects = await runInDurableObject(computer, (_instance, state) =>
    state.storage.sql.exec<{id: string; action: string}>("SELECT id,action FROM effects").toArray().map(value => ({id: value.id, action: JSON.parse(value.action) as ComputerAction})));
  const launches = effects.filter(effect => effect.action.type === "exec");
  expect(launches).toHaveLength(1);
  expect(launches[0]!.action).toEqual({type: "exec", command: "printf native-session-start; sleep 300; printf native-session-end", yieldMs: 0});
  expect(effects.some(effect => effect.action.type === (cancel ? "execCancel" : "execPoll") && effect.action.processId === launches[0]!.id)).toBe(true);
  const {messages} = await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
  expect(messages.filter(message => message.role === "assistant").at(-1)?.text).toBe(cancel ? "The process was cancelled." : "The process completed after polling.");
  const events = await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)), (_instance, state) =>
    state.storage.sql.exec<{data: string}>("SELECT data FROM events").toArray().map(value => JSON.parse(value.data) as BotEvent));
  expect(events.some(event => event.type === "tool.completed" && (event.data.result as {status?: string})?.status === "running")).toBe(true);
  expect((await api(`/v1/bots/${bot.id}/messages`, input)).status).toBe(202);
  expect(await runInDurableObject(computer, (_instance, state) => state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM effects WHERE json_extract(action,'$.type')='exec'").one().count)).toBe(1);
});
