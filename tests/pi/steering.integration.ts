import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Bot, BotEvent, Message, Run, Subagent } from '@botspace/contracts';
import type { Env } from '../../apps/api/src/env';
import { inferenceFixtureControl } from './worker';

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown) => exports.default.fetch(`https://timber.test${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {authorization: 'Bearer test-only-botspace-owner-token-000000', 'content-type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 400 && !predicate(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    value = await read();
  }
  expect(value, 'The named bot did not accept new work while its subagent remained busy').toSatisfy(predicate);
  return value;
}

it('a named bot receives new work while waiting for a child and starts another child without Stop', async () => {
  const {bot} = await (await api('/v1/bots', {name: 'Responsive orchestrator', computerApprovalMode: 'automatic'})).json<{bot: Bot}>();
  const stub = bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  const agents = async () => (await (await api(`/v1/bots/${bot.id}/agents`)).json<{agents: Subagent[]}>()).agents;
  const events = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{data: string}>('SELECT data FROM events').toArray().map(value => JSON.parse(value.data) as BotEvent));
  let release!: () => void;
  inferenceFixtureControl.matches = 'request-native-held-worker';
  inferenceFixtureControl.gate = new Promise(resolve => { release = resolve; });
  try {
    const {run: first} = await (await api(`/v1/bots/${bot.id}/messages`, {text: 'request-native-orchestrator', operationId: crypto.randomUUID()})).json<{run: Run}>();
    await until(events, items => items.some(event => event.type === 'tool.started' && event.data.toolName === 'wait_subagent'));
    const input = {text: 'request-native-parallel-task', operationId: crypto.randomUUID()};
    const {run: second} = await (await api(`/v1/bots/${bot.id}/messages`, input)).json<{run: Run}>();
    const children = await until(agents, values => values.length === 2 && values.every(value => value.status === 'running'));
    expect(children.find(child => child.name === 'First worker')?.parentOperationId).toBe(first.operationId);
    expect(children.find(child => child.name === 'Second worker')?.parentOperationId).toBe(second.operationId);
    for (const task of [first, second]) await until(async () => (await (await api(`/v1/bots/${bot.id}/runs/${task.id}`)).json<{run: Run}>()).run, run => run.status === 'completed');
    const {messages} = await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
    const answers = messages.filter(message => message.role === 'assistant' && message.text === 'I assigned the new task to Second worker while First worker continues.');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.runId).toBe(second.id);
    const duplicate = await (await api(`/v1/bots/${bot.id}/messages`, input)).json<{run: Run}>();
    expect(duplicate.run.id).toBe(second.id);
    expect(await agents()).toHaveLength(2);
    expect((await agents()).every(child => child.status === 'running')).toBe(true);
  } finally {
    release();
    delete inferenceFixtureControl.gate;
    delete inferenceFixtureControl.matches;
    await until(agents, values => values.length > 0 && values.every(value => value.status === 'completed'));
  }
});
