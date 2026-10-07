import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { Bot, ComputerProvider, ConnectionRequest, Message, Run } from '@botspace/contracts';
import type { AgentRuntime, RuntimeHostToolRequest, RuntimeToolResult } from '../packages/runtime/src/types';
import type { Env } from '../apps/api/src/env';

const bindings = env as unknown as Env;
const token = 'test-only-botspace-owner-token-000000';
const api = (path: string, body?: unknown) => exports.default.fetch(`https://botspace.test${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals = {
  runtime: AgentRuntime;
  computer: ComputerProvider;
  github(path: string, method?: string, input?: unknown): Promise<Record<string, unknown>>;
  executeHostTool(input: RuntimeHostToolRequest): Promise<RuntimeToolResult>;
  completeConnection(id: string): Promise<ConnectionRequest>;
  cancelRun(id: string): Promise<Run>;
  project(event: {type: string; operationId: string; data: Record<string, unknown>}): Promise<void>;
};
const hostRequest = (run: Run, input: Partial<RuntimeHostToolRequest> = {}): RuntimeHostToolRequest => ({
  operationId: `host:${crypto.randomUUID()}`, runOperationId: run.operationId,
  name: 'github_clone', arguments: {repository: 'owner/private', path: 'project'},
  signal: new AbortController().signal, ...input,
});
const readRun = async (bot: Bot, run: Run) => (await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run: Run}>()).run;
const readConnections = async (bot: Bot) => (await (await api(`/v1/bots/${bot.id}/connections`)).json<{connections: ConnectionRequest[]}>()).connections;
async function pausedBot(text="fixture:github") {
  const {bot} = await (await api('/v1/bots', {name: 'GitHub connection fixture'})).json<{bot: Bot}>();
  const {run} = await (await api(`/v1/bots/${bot.id}/messages`, {text, operationId: crypto.randomUUID()})).json<{run: Run}>();
  await expect.poll(async () => (await readRun(bot, run)).status).toBe('waiting_connection');
  // Wait for the native fixture observer to settle, so later tests exercise callback state.
  await expect.poll(() => runInDurableObject(stubFor(bot), (_instance, state) => state.storage.get(`fixture-host-result:${run.operationId}`))).toMatchObject({status: 'pending_connection'});
  const [connection] = await readConnections(bot);
  return {bot, run, connection: connection!};
}

it('persists missing repository access inline without starting the computer or accepting credentials in tools', async () => {
  const {bot, run, connection} = await pausedBot();
  expect(connection).toMatchObject({botId: bot.id, runId: run.id, provider: 'github', repository: 'owner/private', permission: 'read', status: 'pending'});
  const computer = bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer, (_instance, state) => state.storage.sql.exec('SELECT id FROM effects').toArray())).toHaveLength(0);
  await runInDurableObject(stubFor(bot), async (instance, state) => {
    const target = instance as unknown as Internals;
    const duplicate = await target.executeHostTool(hostRequest(run, {operationId: `fixture-host:${run.operationId}`, arguments: {repository: 'Owner/Private', path: 'project'}}));
    expect(duplicate).toMatchObject({status: 'pending_connection', requestId: connection.id});
    expect(state.storage.sql.exec('SELECT id FROM connections').toArray()).toHaveLength(1);
    await expect(target.executeHostTool(hostRequest(run, {arguments: {repository: 'owner/private', path: 'project', token: 'must-not-enter-transcript'}}))).rejects.toMatchObject({code: 'invalid_tool_arguments'});
    const stored = JSON.stringify(state.storage.sql.exec('SELECT data FROM messages UNION ALL SELECT data FROM events UNION ALL SELECT data FROM connections').toArray());
    expect(stored).not.toContain('must-not-enter-transcript');
    expect(stored).not.toContain(token);
  });
});

it('requires owner authentication and rejects callback spoofing through the public API', async () => {
  const {bot, run, connection} = await pausedBot();
  for (const path of [`/v1/bots/${bot.id}/connections`, `/v1/bots/${bot.id}/connections/${connection.id}/connect`]) {
    const response = await exports.default.fetch(`https://botspace.test${path}`, {method: path.endsWith('/connect') ? 'POST' : 'GET'});
    expect(response.status).toBe(401);
  }
  const spoofed = await exports.default.fetch(`https://botspace.test/v1/bots/${bot.id}/connections/${connection.id}/complete`, {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'x-timber-internal': 'github'},
  });
  expect(spoofed.status).toBe(404);
  expect((await readRun(bot, run)).status).toBe('waiting_connection');
});

it('queues exactly one durable continuation when concurrent authorization callbacks arrive', async () => {
  const {bot, run, connection} = await pausedBot();
  await runInDurableObject(stubFor(bot), async instance => {
    const target = instance as unknown as Internals;
    target.github = async path => {
      expect(path).toBe('/authorize');
      return {authorized: true};
    };
    const results = await Promise.all([target.completeConnection(connection.id), target.completeConnection(connection.id)]);
    expect(results.map(result => result.status)).toEqual(['connected', 'connected']);
  });
  await expect.poll(async () => (await readRun(bot, run)).status).toBe('completed');
  await runInDurableObject(stubFor(bot), async (instance, state) => {
    const target = instance as unknown as Internals;
    await target.completeConnection(connection.id);
    const continuations = state.storage.sql.exec<{operation_id: string; text: string}>('SELECT operation_id,text FROM submissions WHERE operation_id LIKE ?', 'connection:%').toArray();
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.operation_id).toBe(`connection:${connection.id}`);
    expect(continuations[0]?.text).toContain('was NOT executed');
    expect(continuations[0]?.text).not.toContain(token);
  });
  const {messages} = await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages: Message[]}>();
  expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});

it('routes the GitHub notification to the same owner-scoped bot as the public API', async () => {
  const {bot, run, connection} = await pausedBot();
  await runInDurableObject(stubFor(bot), instance => {
    (instance as unknown as Internals).github = async () => ({authorized: true});
  });
  const github = bindings.GITHUB!.get(bindings.GITHUB!.idFromName('owner'));
  const delivered = await runInDurableObject(github, instance => (instance as unknown as {
    notify(flow: {botId: string; requestId: string; repository?: string; permission: string}): Promise<boolean>;
  }).notify({botId: bot.id, requestId: connection.id, repository: connection.repository, permission: connection.permission}));
  expect(delivered).toBe(true);
  await expect.poll(async () => (await readRun(bot, run)).status).toBe('completed');
});

it('admits a committed connection continuation after a lost callback before admission', async () => {
  const {bot, run, connection} = await pausedBot();
  await runInDurableObject(stubFor(bot), async (instance, state) => {
    const target = instance as unknown as Internals;
    const nativeOperationId = `connection:${connection.id}`;
    // Model the crash boundary after the SQLite transaction, before runtime.submit.
    state.storage.transactionSync(() => {
      state.storage.sql.exec('UPDATE connections SET data=? WHERE id=?', JSON.stringify({...connection, status: 'connected'}), connection.id);
      state.storage.sql.exec('INSERT INTO submissions(operation_id,run_id,text) VALUES(?,?,?)', nativeOperationId, run.id, 'Recovered connection continuation');
      state.storage.sql.exec('UPDATE runs SET native_operation_id=?,data=? WHERE id=?', nativeOperationId, JSON.stringify({...run, status: 'queued'}), run.id);
    });
    expect((await target.runtime.operation(nativeOperationId)).status).toBe('missing');
    await target.completeConnection(connection.id);
    expect((await target.runtime.operation(nativeOperationId)).status).not.toBe('missing');
    expect(state.storage.sql.exec<{admitted: number}>('SELECT admitted FROM submissions WHERE operation_id=?', nativeOperationId).one().admitted).toBe(1);
  });
});

it('can complete an older pending request after newer connection history exceeds the display limit', async () => {
  const {bot, connection} = await pausedBot();
  await runInDurableObject(stubFor(bot), async (instance, state) => {
    const target = instance as unknown as Internals;
    target.github = async () => ({authorized: true});
    for (let i = 0; i < 101; i++) {
      const previous = {...connection, id: crypto.randomUUID(), status: 'connected'};
      state.storage.sql.exec('INSERT INTO connections(id,operation_id,fingerprint,data) VALUES(?,?,?,?)', previous.id, `history:${previous.id}`, 'fixture', JSON.stringify(previous));
    }
    expect((await target.completeConnection(connection.id)).status).toBe('connected');
  });
});

it('does not resume a cancelled run when authorization finishes after cancellation', async () => {
  const {bot, run, connection} = await pausedBot();
  let authorizeStarted = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await runInDurableObject(stubFor(bot), instance => {
    (instance as unknown as Internals).github = async () => {authorizeStarted = true; await gate; return {authorized: true};};
  });
  const completion = runInDurableObject(stubFor(bot), instance => (instance as unknown as Internals).completeConnection(connection.id));
  try {
    await expect.poll(() => authorizeStarted).toBe(true);
    expect((await (await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`, {})).json<{run: Run}>()).run.status).toBe('cancelled');
    release();
    expect((await completion).status).toBe('cancelled');
    expect((await readRun(bot, run)).status).toBe('cancelled');
    expect((await readConnections(bot))[0]?.status).toBe('cancelled');
    await runInDurableObject(stubFor(bot), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT operation_id FROM submissions WHERE operation_id LIKE ?', 'connection:%').toArray()).toHaveLength(0);
    });
  } finally {release(); await completion.catch(() => {});}
});

it('rejects superseded native tool calls and ignores their late failure after a connection continuation', async () => {
  const {bot, run, connection} = await pausedBot();
  let release!: (value: Awaited<ReturnType<AgentRuntime['wait']>>) => void;
  const held = new Promise<Awaited<ReturnType<AgentRuntime['wait']>>>(resolve => {release = resolve;});
  try {
    await runInDurableObject(stubFor(bot), async (instance, state) => {
      const target = instance as unknown as Internals;
      const runtime = target.runtime;
      target.runtime = {...runtime, wait: id => id.startsWith('connection:') ? held : runtime.wait(id)};
      target.github = async () => ({authorized: true});
      let effects = 0;
      target.computer = {...target.computer, exec: async (_botId, operationId) => {effects++; return {operationId, status: 'completed'};}};
      await target.completeConnection(connection.id);
      await target.project({operationId: run.operationId, type: 'run.failed', data: {reason: 'terminated'}});
      const result = await target.executeHostTool(hostRequest(run));
      expect(result.status).toBe('interrupted');
      expect(effects).toBe(0);
      expect(JSON.parse(state.storage.sql.exec<{data: string}>('SELECT data FROM runs WHERE id=?', run.id).one().data).status).toBe('queued');
    });
  } finally {release({operationId: `connection:${connection.id}`, status: 'done', text: 'Completed after authorization.'});}
});

it('does not dispatch an old tool when a connection callback supersedes it during authorization', async () => {
  const {bot, run, connection} = await pausedBot();
  let authorizeStarted = false;
  let releaseAuthorize!: () => void;
  let finishContinuation!: (value: Awaited<ReturnType<AgentRuntime['wait']>>) => void;
  const authorization = new Promise<void>(resolve => {releaseAuthorize = resolve;});
  const continuation = new Promise<Awaited<ReturnType<AgentRuntime['wait']>>>(resolve => {finishContinuation = resolve;});
  let effects = 0;
  await runInDurableObject(stubFor(bot), instance => {
    const target = instance as unknown as Internals;
    const runtime = target.runtime;
    target.runtime = {...runtime, wait: id => id.startsWith('connection:') ? continuation : runtime.wait(id)};
    let checks = 0;
    target.github = async () => {
      if (++checks === 1) {authorizeStarted = true; await authorization;}
      return {authorized: true};
    };
    target.computer = {...target.computer, exec: async (_botId, operationId) => {effects++; return {operationId, status: 'completed'};}};
  });
  const pending = runInDurableObject(stubFor(bot), instance => (instance as unknown as Internals).executeHostTool(hostRequest(run)));
  try {
    await expect.poll(() => authorizeStarted).toBe(true);
    await runInDurableObject(stubFor(bot), instance => (instance as unknown as Internals).completeConnection(connection.id));
    releaseAuthorize();
    expect((await pending).status).toBe('interrupted');
    expect(effects).toBe(0);
  } finally {
    releaseAuthorize();
    finishContinuation({operationId: `connection:${connection.id}`, status: 'done', text: 'Completed safely.'});
    await pending.catch(() => {});
  }
});

it('does not recreate a waiting run if it is cancelled while the connection fingerprint is computed', async () => {
  const {bot, run} = await pausedBot();
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    started = true;
    await gate;
    return digest(algorithm, data);
  });
  const pending = runInDurableObject(stubFor(bot), async instance => {
    const target = instance as unknown as Internals;
    target.github = async () => ({authorized: false});
    return target.executeHostTool(hostRequest(run));
  });
  try {
    await expect.poll(() => started).toBe(true);
    await runInDurableObject(stubFor(bot), instance => (instance as unknown as Internals).cancelRun(run.id));
    release();
    expect((await pending).status).toBe('interrupted');
    expect((await readRun(bot, run)).status).toBe('cancelled');
    expect((await readConnections(bot)).every(connection => connection.status !== 'pending')).toBe(true);
  } finally {release(); spy.mockRestore(); await pending.catch(() => {});}
});

it.each(['https://github.com/owner/repo', 'owner/repo/extra', '../repo', 'owner/..', 'owner/.', 'owner/repo?token=secret', 'owner/repo\n'])(
  'rejects malformed repository identifiers before service access: %s', async repository => {
    const {bot, run} = await pausedBot();
    await runInDurableObject(stubFor(bot), async instance => {
      const target = instance as unknown as Internals;
      target.github = async () => {throw new Error('Repository validation must happen before service access');};
      await expect(target.executeHostTool(hostRequest(run, {arguments: {repository, path: 'project'}}))).rejects.toMatchObject({code: 'invalid_repository'});
    });
  },
);


it('connects the account without a repository and resumes the original task after owner authorization',async()=>{
  const {bot,run,connection}=await pausedBot('fixture:github-account');
  expect(connection.repository).toBeUndefined();
  expect(connection).toMatchObject({provider:'github',permission:'read',status:'pending'});
  const response=await api(`/v1/bots/${bot.id}/connections/${connection.id}/connect`,{});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({url:expect.stringContaining('/github/setup/start?state=')});
  await runInDurableObject(stubFor(bot),async instance=>{
    const target=instance as unknown as Internals;target.github=async(path,_method,input)=>{expect(path).toBe('/authorize');expect((input as Record<string,unknown>).repository).toBeUndefined();return {authorized:true};};
    await target.completeConnection(connection.id);
  });
  await expect.poll(async()=>(await readRun(bot,run)).status).toBe('completed');
});

it('reconciles pending tasks in multiple bots after account authorization outside their original cards',async()=>{
  const first=await pausedBot(),second=await pausedBot();
  for(const {bot} of [first,second]) await runInDurableObject(stubFor(bot),instance=>{(instance as unknown as Internals).github=async()=>({authorized:true});});
  const github=bindings.GITHUB!.get(bindings.GITHUB!.idFromName('owner'));
  await runInDurableObject(github,async(instance,state)=>{
    // These watchers were registered by the original failed access checks.
    expect(await state.storage.get(`waiting-bot:${first.bot.id}`)).toBeTruthy();
    const reconcile=(instance as unknown as {reconcileWaitingBots():Promise<void>}).reconcileWaitingBots.bind(instance);
    await reconcile();await reconcile();
  });
  for(const {bot,run,connection} of [first,second]) {
    await expect.poll(async()=>(await readRun(bot,run)).status).toBe('completed');
    await runInDurableObject(stubFor(bot),(_instance,state)=>{
      expect(state.storage.sql.exec('SELECT operation_id FROM submissions WHERE operation_id=?',`connection:${connection.id}`).toArray()).toHaveLength(1);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM connections WHERE id=?',connection.id).one().data).status).toBe('connected');
    });
  }
});

it('does not resume a cancelled task when shared GitHub authorization is reconciled',async()=>{
  const {bot,run}=await pausedBot();await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`,{});
  await runInDurableObject(stubFor(bot),instance=>{(instance as unknown as Internals).github=async()=>({authorized:true});});
  const github=bindings.GITHUB!.get(bindings.GITHUB!.idFromName('owner'));
  await runInDurableObject(github,instance=>(instance as unknown as {reconcileWaitingBots():Promise<void>}).reconcileWaitingBots());
  expect((await readRun(bot,run)).status).toBe('cancelled');
  await runInDurableObject(stubFor(bot),(_instance,state)=>{expect(state.storage.sql.exec('SELECT operation_id FROM submissions WHERE operation_id LIKE ?', 'connection:%').toArray()).toHaveLength(0);});
});


it('does not rewind a newer native operation when an old connection request is reconciled',async()=>{
  const {bot,run,connection}=await pausedBot();
  await runInDurableObject(stubFor(bot),async(instance,state)=>{
    const target=instance as unknown as Internals;target.github=async()=>({authorized:true});
    state.storage.sql.exec('UPDATE runs SET native_operation_id=? WHERE id=?','newer-native-input',run.id);
    expect((await target.completeConnection(connection.id)).status).toBe('cancelled');
    expect(state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',run.id).one().native_operation_id).toBe('newer-native-input');
    expect(state.storage.sql.exec('SELECT operation_id FROM submissions WHERE operation_id=?',`connection:${connection.id}`).toArray()).toHaveLength(0);
  });
});
