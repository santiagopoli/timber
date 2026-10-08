import { DurableObject } from 'cloudflare:workers';
import { createPiRuntime, DEFAULT_MODEL, type RuntimeApprovalContext } from '../src/index.js';
import { responsesFixture } from './responses-fixture.js';

const CF_MODEL = '@cf/moonshotai/kimi-k2.7-code';

/** Fake ONLY the external inference transport; Pi, lifecycle and SQLite are real. */
export class HarnessProbe extends DurableObject {
  runtime: ReturnType<typeof createPiRuntime>;
  heldTool?: Promise<void>;
  releaseHeldTool?: () => void;
  heldInference?: Promise<void>;
  releaseHeldInference?: () => void;
  holdInferenceAfterToolCount?: number;
  toolDelayMs?: number;
  toolFailure?: boolean;
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, input TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tool_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, input TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS host_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, input TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS projected(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS admission_wakes(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT)');
    this.runtime = createPiRuntime({
      owner: this, storage: ctx.storage, defaultModel: CF_MODEL,
      maxGenerations: JSON.parse(this.setting('maxGenerations') ?? 'null'),
      maxToolCalls: JSON.parse(this.setting('maxToolCalls') ?? 'null'),
      chatgpt: { fetch: async request => {
        const input = await request.json<{ input: Record<string, unknown>[] }>();
        const call = ctx.storage.sql.exec<{id:number}>('INSERT INTO calls(input) VALUES(?) RETURNING id', JSON.stringify({ ...input, fixtureUrl: request.url, fixtureHeaders: Object.fromEntries(request.headers) })).one();
        if (input.input.filter(item => item.type === 'function_call_output').length === this.holdInferenceAfterToolCount) {
          // Match a real fetch: cancellation must release a held provider request.
          const signal = request.signal;
          let rejectAbort!: (reason: unknown) => void;
          const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
          const onAbort = () => rejectAbort(signal.reason);
          signal.addEventListener('abort', onAbort, {once:true});
          if(signal.aborted)onAbort();
          try {await Promise.race([this.heldInference, aborted]);}
          finally {signal.removeEventListener('abort', onAbort);}
        }
        return responsesFixture(input,call.id);
      } },
      ai: { run: async (_model: string, input: { messages: { role: string; content: unknown }[] }) => {
        ctx.storage.sql.exec('INSERT INTO calls(input) VALUES(?)', JSON.stringify(input));
        const user = input.messages.filter(message => message.role === 'user').at(-1);
        const text = JSON.stringify(user?.content);
        if (text.includes('billing-fixture')) return Response.json({ success: false, errors: [{ code: 5035, message: 'This model is not available on the Workers Free plan. Private example detail must not be projected.' }] }, { status: 403 });
        const toolRequest = text.includes('request-exec') || text.includes('request-loop');
        const readCall = { index: 0, id: 'call-read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/test.txt"}' } };
        const execCall = { index: text.includes('mixed') ? 1 : 0, id: 'call-fixture-1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo fixture"}' } };
        const calls = text.includes('request-loop') ? [readCall] : text.includes('mixed') ? [readCall, execCall] : [execCall];
        const delta = toolRequest ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: 'Hello from the real Pi harness.' };
        const chunks = [
          { id: 'test-generation', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
          { id: 'test-generation', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: toolRequest ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } } as unknown as Ai,
      getBot: async () => ({ name: 'Ada', instructions: 'Your private instruction is amber-lantern.', model: this.setting('model') ?? CF_MODEL, computerApprovalMode: this.setting('approvalMode') === 'automatic' ? 'automatic' : 'ask' }),
      getApprovalContext: async () => {
        if (this.setting('approvalContext') === 'unavailable') throw new Error('fixture host context unavailable');
        return JSON.parse(this.setting('approvalContext') ?? '{"active":[],"recent":[]}') as RuntimeApprovalContext;
      },
      tools: {
        catalog: async () => [{ name: 'github_clone', description: 'Clone an authorized repository.', inputSchema: { type: 'object', properties: { repository: { type: 'string' }, path: { type: 'string' } }, required: ['repository', 'path'] } }],
        call: async ({ operationId, runOperationId, toolCallId, name, arguments: args }) => {
          ctx.storage.sql.exec('INSERT INTO host_calls(input) VALUES(?)', JSON.stringify({ operationId, runOperationId, toolCallId, name, arguments: args }));
          return this.setting('githubConnected') === 'true'
            ? { operationId, status: 'completed', output: 'Repository cloned by the host.' }
            : { status: 'pending_connection', requestId: 'connection-fixture', provider: 'github', repository: 'owner/private', permission: 'write' };
        },
        execute: async ({ operationId, runOperationId, toolCallId, action }) => {
          // Enforce the real computer boundary, even though execution is a fixture.
          if (operationId.length > 160 || /[^A-Za-z0-9:_.-]/.test(operationId)) throw new Error('Invalid computer operation ID');
          const call = ctx.storage.sql.exec<{ id: number }>('INSERT INTO tool_calls(input) VALUES(?) RETURNING id', JSON.stringify({ operationId, runOperationId, toolCallId, action })).one();
          await this.heldTool;
          if (this.toolDelayMs) await new Promise(resolve => setTimeout(resolve, this.toolDelayMs));
          const nextContext = this.setting('afterToolApprovalContext');
          if (nextContext) ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'approvalContext', nextContext);
          if (this.toolFailure) return {operationId,status:'failed',exitCode:1,output:'fixture command failed',error:'Command exited with code 1.'};
          return action.type === 'readFile' ? { operationId, status: 'completed', output: 'test file' } : action.type === 'screenshot' ? { operationId, status: 'completed', artifactId: 'test.png' } : this.setting('approvalMode') === 'automatic' ? { operationId, status: 'completed', output: 'fixture completed' } : { status: 'pending_approval', approvalId: `approval-fixture-${call.id}` };
        },
        readImage: async () => ({ data: 'aW1hZ2U=', mimeType: 'image/png' }),
      },
      onEvent: event => { ctx.storage.sql.exec('INSERT INTO projected(event) VALUES(?)', JSON.stringify(event)); },
      onAdmissionRetry: async operationId => {
        ctx.storage.sql.exec('INSERT INTO admission_wakes(operation_id) VALUES(?)', operationId);
        if (this.setting('admissionRescheduleOnce') === operationId) {
          ctx.storage.sql.exec('DELETE FROM config WHERE key=?', 'admissionRescheduleOnce');
          await this.runtime.scheduleAdmissionRetry(operationId, 60_000);
        }
      },
    });
  }
  private setting(key: string) { return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM config WHERE key=?', key).toArray()[0]?.value; }
  async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/host-context') {
      const input = await request.json<{ approvals?: RuntimeApprovalContext | 'unavailable'; afterToolApprovals?: RuntimeApprovalContext; mode?: 'ask' | 'automatic'; githubConnected?: boolean }>();
      if (input.approvals) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'approvalContext', input.approvals === 'unavailable' ? 'unavailable' : JSON.stringify(input.approvals));
      if (input.afterToolApprovals) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'afterToolApprovalContext', JSON.stringify(input.afterToolApprovals));
      if (input.mode) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'approvalMode', input.mode);
      if (typeof input.githubConnected === 'boolean') this.ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'githubConnected', JSON.stringify(input.githubConnected));
      return Response.json({ ok: true });
    }
    if (path === '/submit') {
      const input = await request.json<{ text: string; operationId: string; chatgpt?: boolean }>();
      if (input.chatgpt) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', 'model', DEFAULT_MODEL);
      return Response.json(await this.runtime.submit(input.text, { operationId: input.operationId }));
    }
    if (path === '/wait') return Response.json(await this.runtime.wait(new URL(request.url).searchParams.get('id')!));
    if (path === '/inspect') return Response.json({
      messages: await this.runtime.messages(),
      calls: ctxRows(this.ctx.storage, 'SELECT input FROM calls'),
      toolCalls: ctxRows(this.ctx.storage, 'SELECT input FROM tool_calls'),
      hostCalls: ctxRows(this.ctx.storage, 'SELECT input FROM host_calls'),
      events: ctxRows(this.ctx.storage, 'SELECT event FROM projected'),
    });
    return new Response('Not found', { status: 404 });
  }
}
function ctxRows(storage: DurableObjectStorage, query: string) { return storage.sql.exec(query).toArray(); }
export default {
  fetch(request: Request, env: { PROBE: DurableObjectNamespace<HarnessProbe> }) {
    return env.PROBE.getByName(request.headers.get('x-probe-id') ?? 'probe').fetch(request);
  },
};
