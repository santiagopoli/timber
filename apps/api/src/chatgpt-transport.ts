import {DurableObject} from 'cloudflare:workers';
import {ApiError, errorResponse} from './errors';
import type {Env} from './env';

const IDLE_MS = 3 * 60_000;

/** Private, fixed-destination Node transport. Separate from every bot computer. */
export class ChatGPTTransportDO extends DurableObject<Env> {
  private token = '';
  private starting?: Promise<void>;
  private get container() { return this.ctx.container; }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.token = await ctx.storage.get<string>('transportToken') ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      await ctx.storage.put('transportToken', this.token);
    });
  }
  private async health(): Promise<{ok:boolean;active:number}> {
    const response = await this.container!.getTcpPort(8080).fetch('http://transport/health', {
      headers: {'x-timber-transport-token': this.token}, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('transport_not_ready');
    const result = await response.json<{ok:boolean;active:number}>();
    if (result.ok !== true || !Number.isSafeInteger(result.active) || result.active < 0) throw new Error('transport_not_ready');
    return result;
  }
  private async ready(): Promise<void> {
    if (this.starting) return this.starting;
    const work = (async () => {
      if (!this.container?.images.base) throw new ApiError(503, 'model_transport_unavailable', 'The ChatGPT server transport is unavailable.');
      // The previous lite transport never became ready. Retire that dedicated
      // instance once; it has no bot processes, workspace or admitted inference.
      if (await this.ctx.storage.get<string>('resourceVersion') !== 'standard-1-v1') {
        if (this.container.running) await this.container.destroy();
        await this.ctx.storage.put('resourceVersion', 'standard-1-v1');
      }
      if (!this.container.running) this.container.start({image: this.container.images.base, instance: 'standard-1', enableInternet: true,
        entrypoint: ['/usr/local/bin/node', '/opt/botspace/chatgpt-transport.mjs'], env: {TIMBER_TRANSPORT_TOKEN: this.token}});
      // Safety cap; the alarm stops idle instances sooner and never interrupts
      // an active response. No OAuth values or conversations are checkpointed.
      await this.container.setInactivityTimeout(35 * 60_000);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { await this.health(); return; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      throw new ApiError(503, 'model_transport_unavailable', 'The ChatGPT server transport did not start.');
    })();
    this.starting = work;
    try { await work; } finally { if (this.starting === work) this.starting = undefined; }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('x-timber-internal') !== 'chatgpt-transport' || url.search ||
      !(url.pathname === '/v1/models' && request.method === 'GET' || url.pathname === '/v1/responses' && request.method === 'POST')) {
      await request.body?.cancel().catch(() => {}); return new Response(null, {status: 404});
    }
    try {
      await this.ctx.storage.put('lastActivity', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      await this.ready();
      if (request.signal.aborted) throw new Error('transport_cancelled');
      const headers = new Headers();
      for (const name of ['authorization', 'session_id']) {const value = request.headers.get(name); if (value) headers.set(name, value);}
      headers.set('x-timber-transport-token', this.token);
      return await this.container!.getTcpPort(8080).fetch(new Request(`http://transport${url.pathname}`, {
        method: request.method, headers, body: request.body, signal: request.signal, redirect: 'manual',
      }));
    } catch (error) {
      return errorResponse(error instanceof ApiError ? error : new ApiError(502, 'model_connection_interrupted', 'Connection lost while contacting ChatGPT. Try again later.'));
    }
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.container?.running) return;
      const last = await this.ctx.storage.get<number>('lastActivity') ?? 0;
      try {
        const health = await this.health();
        if (health.active > 0 || Date.now() - last < IDLE_MS) {
          await this.ctx.storage.setAlarm(Date.now() + 60_000); return;
        }
        await this.container.destroy();
      } catch { await this.ctx.storage.setAlarm(Date.now() + 60_000); }
    });
  }
}
