import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Approval, Bot, BotEvent, ComputerProvider, Run } from '@botspace/contracts';
import type { RuntimeHostToolRequest, RuntimeToolRequest, RuntimeToolResult } from '../packages/runtime/src/types';
import type { Env } from '../apps/api/src/env';
import { computerActivityInput, hostActivityInput } from '../apps/api/src/tool-activity';
import { fingerprint } from '../apps/api/src/validation';

const bindings = env as unknown as Env;
const api = (path: string, body?: unknown) => exports.default.fetch(`https://botspace.test${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {authorization: 'Bearer test-only-botspace-owner-token-000000', 'content-type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
const stubFor = (bot: Bot) => bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals = {
  computer: ComputerProvider;
  executeTool(input: RuntimeToolRequest): Promise<RuntimeToolResult>;
  executeHostTool(input: RuntimeHostToolRequest): Promise<RuntimeToolResult>;
  finishApproval(approval: Approval): Promise<void>;
  github(path: string, method?: string, input?: unknown): Promise<Record<string, unknown>>;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function activeBot() {
  const {bot} = await (await api('/v1/bots', {name: 'Tool activity', computerApprovalMode: 'automatic'})).json<{bot: Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  const now = new Date().toISOString();
  const run: Run = {id: crypto.randomUUID(), botId: bot.id, operationId: crypto.randomUUID(), status: 'running', createdAt: now, updatedAt: now};
  // Hold a real host run open without a model racing the deliberately delayed
  // provider. Provider dispatch, validation, event persistence and deduplication
  // remain the production paths exercised below.
  await runInDurableObject(stubFor(bot), (_instance, state) => {
    state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)', run.id, run.operationId, 'fixture', run.operationId, JSON.stringify(run));
    state.storage.sql.exec('INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)', run.operationId, run.id, 'Inspect tool activity');
  });
  return {bot, run};
}
const events = (storage: DurableObjectStorage, operationId: string) => storage.sql.exec<{data: string}>(
  "SELECT data FROM events WHERE json_extract(data,'$.data.operationId')=? AND json_extract(data,'$.type')!='process.updated' ORDER BY id", operationId,
).toArray().map(row => JSON.parse(row.data) as BotEvent);

describe('live tool activity projection', () => {
  it('persists the actual command before a slow provider finishes and preserves one identity across duplicate observations', async () => {
    const {bot, run} = await activeBot();
    const operationId = `activity:${crypto.randomUUID()}`;
    await runInDurableObject(stubFor(bot), async (instance, state) => {
      const target = instance as unknown as Internals;
      const provider = target.computer;
      const entered = deferred(), release = deferred();
      target.computer = {...provider, exec: async (...args) => {entered.resolve(); await release.promise; return provider.exec(...args);}};
      const input: RuntimeToolRequest = {operationId, runOperationId: run.operationId, toolCallId: 'native_call|provider_identity', action: {type: 'exec', command: 'uname -a && pwd', timeoutMs: 10_000}, signal: new AbortController().signal};
      const pending = target.executeTool(input);
      try {
        await entered.promise;
        expect(events(state.storage, operationId)).toHaveLength(1);
        expect(events(state.storage, operationId)[0]).toMatchObject({type: 'tool.started', runId: run.id, data: {
          operationId, toolCallId: input.toolCallId, actionType: 'exec', input: {command: 'uname -a && pwd', timeoutMs: 10_000},
        }});
        expect(events(state.storage, operationId)[0].data).not.toHaveProperty('result');
        release.resolve();
        const first = await pending;
        expect(first.status).toBe('completed');
        expect(await target.executeTool(input)).toEqual(first);
        const history = events(state.storage, operationId);
        expect(history.map(event => event.type)).toEqual(['tool.started', 'tool.completed']);
        expect(history[1].data).toMatchObject({operationId, toolCallId: input.toolCallId, input: {command: 'uname -a && pwd', timeoutMs: 10_000}, result: first});
      } finally {release.resolve(); await pending.catch(() => {}); target.computer = provider;}
    });
    const computer = bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
    await runInDurableObject(computer, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT id FROM effects WHERE id=?', operationId).toArray()).toHaveLength(1);
    });
  });

  it('shows an approved action while it runs, without duplicating its start on concurrent finalization', async () => {
    const {bot, run} = await activeBot();
    await runInDurableObject(stubFor(bot), async (instance, state) => {
      const target = instance as unknown as Internals;
      const provider = target.computer;
      const entered = deferred(), release = deferred();
      let effects = 0;
      target.computer = {...provider, exec: async (_botId, operationId) => {effects++; entered.resolve(); await release.promise; return {operationId, status: 'completed', output: 'Wrote app.py'};}};
      const approval: Approval = {id: crypto.randomUUID(), botId: bot.id, runId: run.id, operationId: `approved:${crypto.randomUUID()}`, toolCallId: 'write-call', status: 'executing', action: {type: 'writeFile', path: 'app.py', content: 'private file contents'}, createdAt: run.createdAt, expiresAt: new Date(Date.now() + 60_000).toISOString()};
      state.storage.sql.exec('INSERT INTO approvals(id,operation_id,fingerprint,data) VALUES(?,?,?,?)', approval.id, approval.operationId, await fingerprint(approval.action), JSON.stringify(approval));
      const pending = target.finishApproval(approval);
      try {
        await entered.promise;
        const duplicate = target.finishApproval(approval);
        expect(events(state.storage, approval.operationId).map(event => event.type)).toEqual(['tool.started']);
        expect(events(state.storage, approval.operationId)[0].data).toMatchObject({actionType: 'writeFile', input: {path: 'app.py'}});
        expect(JSON.stringify(events(state.storage, approval.operationId))).not.toContain('private file contents');
        // Cancel the waiting run before releasing the effect: this test checks
        // the approval journal without scheduling another inference.
        state.storage.sql.exec('UPDATE runs SET data=? WHERE id=?', JSON.stringify({...run, status: 'cancelled'}), run.id);
        release.resolve();
        await Promise.all([pending, duplicate]);
        expect(effects).toBe(1);
        expect(events(state.storage, approval.operationId).map(event => event.type)).toEqual(['tool.started', 'tool.completed']);
      } finally {release.resolve(); await pending.catch(() => {}); target.computer = provider;}
    });
  });

  it('publishes the resolved host tool and repository before a slow GitHub operation returns', async () => {
    const {bot, run} = await activeBot();
    await runInDurableObject(stubFor(bot), async (instance, state) => {
      const target = instance as unknown as Internals;
      const originalGithub = target.github;
      const entered = deferred(), release = deferred();
      target.github = async path => {
        if (path === '/authorize') return {authorized: true};
        expect(path).toBe('/mcp');
        entered.resolve();
        await release.promise;
        return {status: 'completed', data: {number: 42}};
      };
      const input: RuntimeHostToolRequest = {operationId: `github:${crypto.randomUUID()}`, runOperationId: run.operationId, toolCallId: 'github-call', name: 'github_create_pull_request', arguments: {repository: 'owner/project', head: 'fix/activity', base: 'main', title: 'Private title', body: 'Private PR body'}, signal: new AbortController().signal};
      const pending = target.executeHostTool(input);
      try {
        await entered.promise;
        const history = events(state.storage, input.operationId);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({type: 'tool.started', data: {operationId: input.operationId, toolCallId: input.toolCallId, toolName: input.name, input: {repository: 'owner/project', head: 'fix/activity', base: 'main'}}});
        expect(JSON.stringify(history)).not.toContain('Private');
        release.resolve();
        expect((await pending).status).toBe('completed');
        expect(events(state.storage, input.operationId).map(event => event.type)).toEqual(['tool.started', 'tool.completed']);
      } finally {release.resolve(); await pending.catch(() => {}); target.github = originalGithub;}
    });
  });
});

describe('activity display arguments', () => {
  it('omits file bodies, typed text and unknown host fields while retaining useful parameters', () => {
    expect(computerActivityInput({type: 'writeFile', path: 'blender/animar_escena.py', content: 'secret file body'})).toEqual({path: 'blender/animar_escena.py'});
    expect(computerActivityInput({type: 'type', text: 'secret 🔒'})).toEqual({characters: 8});
    expect(computerActivityInput({type: 'click', x: 25, y: 40})).toEqual({x: 25, y: 40, button: 'left'});
    expect(computerActivityInput({type: 'scroll', direction: 'down'})).toEqual({direction: 'down', amount: 3});
    expect(hostActivityInput('github_clone', {repository: 'owner/repo', path: 'repo', branch: 'main', token: 'secret'})).toEqual({repository: 'owner/repo', path: 'repo', branch: 'main'});
    expect(hostActivityInput('unrecognized_tool', {token: 'secret'})).toEqual({});
  });

  it('removes URL credentials, query values and common shell credential forms from durable previews', () => {
    expect(computerActivityInput({type: 'navigate', url: 'https://user:password@example.com/docs?token=secret#private'})).toEqual({url: 'https://example.com/docs?…#…'});
    const command = 'GITHUB_TOKEN=private-token curl -H "Authorization: Bearer private-bearer" --password "private-password" -u "private-user:private-pass" "https://user:private-auth@example.com/api?key=private-query"';
    const preview = computerActivityInput({type: 'exec', command});
    expect(preview.command).toContain('curl');
    expect(preview.command).not.toContain('private-');
    expect(preview.command).toContain('[redacted]');
    expect(preview.command).toContain('https://example.com/api?…');
    expect(computerActivityInput({type: 'exec', command: 'cat > app.py <<\'PY\'\nprivate file body\nPY'}).command).toBe("cat > app.py <<'PY'\n[heredoc omitted]");
    expect(command).toContain('private-token'); // Display does not rewrite execution arguments.
  });
});
