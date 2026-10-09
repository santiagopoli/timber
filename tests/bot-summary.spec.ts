import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Bot, Message, Run } from '@botspace/contracts';
import type { Env } from '../apps/api/src/env';

const bindings = env as unknown as Env;
const token = 'test-only-botspace-owner-token-000000';
const api = (path: string, body?: unknown) => exports.default.fetch(`https://timber.test${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});

it('sidebar summary reads bounded recent text and root/agent activity without admitting queued work', async () => {
  const {bot} = await (await api('/v1/bots', {name: 'Sidebar activity'})).json<{bot: Bot}>();
  const endpoint = `/v1/bots/${bot.id}/summary`;
  expect(await (await api(endpoint)).json()).toEqual({summary: {status: 'ready', activeRuns: 0, activeAgents: 0, activeProcesses: 0}});
  const stub = bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(stub, (_instance, state) => {
    const now = new Date().toISOString();
    for (const [index, status, subagentId] of [[0, 'completed', undefined], [1, 'queued', undefined], [2, 'waiting_approval', undefined], [3, 'running', 'one-child'], [4, 'queued', 'one-child']] as const) {
      const operationId = `summary-input-${index}`;
      const run: Run = {id: crypto.randomUUID(), botId: bot.id, operationId, status, ...(subagentId ? {subagentId} : {}), createdAt: now, updatedAt: now};
      state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)', run.id, operationId, operationId, operationId, JSON.stringify(run));
      if (index === 1) state.storage.sql.exec('INSERT INTO submissions(operation_id,run_id,text) VALUES(?,?,?)', operationId, run.id, 'This should remain unadmitted during a summary read.');
    }
    for (const [role, text] of [['user', 'Earlier request'], ['assistant', 'a'.repeat(400)], ['tool', 'internal tool result']] as const) {
      const message: Message = {id: crypto.randomUUID(), botId: bot.id, role, text, createdAt: now};
      state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?)', message.id, `summary-message-${role}`, JSON.stringify(message));
    }
  });
  const response = await api(endpoint);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({summary: {status: 'waiting_approval', activeRuns: 2, activeAgents: 1, activeProcesses: 0, lastMessage: {text: 'a'.repeat(240), createdAt: expect.any(String)}}});
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{admitted: number}>('SELECT admitted FROM submissions WHERE operation_id=?', 'summary-input-1').one().admitted)).toBe(0);
});

it('sidebar summaries remain authenticated and scoped to the selected bot', async () => {
  const {bot} = await (await api('/v1/bots', {name: 'Separate summary'})).json<{bot: Bot}>();
  expect((await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/summary`)).status).toBe(401);
  expect((await api(`/v1/bots/${crypto.randomUUID()}/summary`)).status).toBe(404);
  expect(await (await api(`/v1/bots/${bot.id}/summary`)).json()).toEqual({summary: {status: 'ready', activeRuns: 0, activeAgents: 0, activeProcesses: 0}});
});
