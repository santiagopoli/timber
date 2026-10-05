import { DurableObject } from 'cloudflare:workers';
import { createPiRuntime, DEFAULT_MODEL } from '../src/index.js';

/** Fake ONLY the external inference transport; Pi, lifecycle and SQLite are real. */
export class HarnessProbe extends DurableObject {
  runtime: ReturnType<typeof createPiRuntime>;
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, input TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS projected(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT)');
    this.runtime = createPiRuntime({
      owner: this, storage: ctx.storage,
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
      getBot: async () => ({ name: 'Ada', instructions: 'Your private instruction is amber-lantern.', model: DEFAULT_MODEL }),
      tools: { execute: async ({ operationId, action }) => action.type === 'readFile' ? { operationId, status: 'completed', output: 'test file' } : { status: 'pending_approval', approvalId: 'approval-fixture' } },
      onEvent: event => { ctx.storage.sql.exec('INSERT INTO projected(event) VALUES(?)', JSON.stringify(event)); },
    });
  }
  async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/submit') {
      const input = await request.json<{ text: string; operationId: string }>();
      return Response.json(await this.runtime.submit(input.text, { operationId: input.operationId }));
    }
    if (path === '/wait') return Response.json(await this.runtime.wait(new URL(request.url).searchParams.get('id')!));
    if (path === '/inspect') return Response.json({
      messages: await this.runtime.messages(),
      calls: ctxRows(this.ctx.storage, 'SELECT input FROM calls'),
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
