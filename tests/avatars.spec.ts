import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarJob, AvatarSettings, AvatarTheme, Bot, ModelOption } from '@botspace/contracts';
import type { Env } from '../apps/api/src/env';
import { AvatarCoordinator } from '../apps/api/src/avatars';
import { errorResponse } from '../apps/api/src/errors';
import { sanitizeAvatarSvg } from '../apps/api/src/avatar-svg';

const bindings = env as unknown as Env;
const MODEL = 'gpt-6.1-sol';
const SVG = '<svg viewBox="0 0 128 128"><path d="M12 12L50 12L30 50Z" fill="#abc"/></svg>';
const models: ModelOption[] = [{ id: MODEL, name: 'Test text model', provider: 'openai', reasoningEfforts: ['medium'], supportsFast: false, inputModalities: ['text', 'image'] }];
const api = (path: string, method = 'GET', body?: unknown, authorized = true, headers: Record<string,string> = {}) => exports.default.fetch(`https://botspace.test${path}`, {
  method, headers: { ...(authorized ? { authorization: 'Bearer test-only-botspace-owner-token-000000' } : {}), 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const stub = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName(`avatar-test:${crypto.randomUUID()}`));
const request = (path: string, method = 'GET', body?: unknown) => new Request(`https://workspace${path}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function call(coordinator: AvatarCoordinator, path: string, method = 'GET', body?: unknown): Promise<Response> {
  try { return await coordinator.fetch(request(path, method, body)); } catch (error) { return errorResponse(error); }
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
function fakeProvider(options: { connected?: boolean; availableModels?: ModelOption[]; response?: (request: Request) => Promise<Response>; catalogue?: () => Promise<Response> } = {}) {
  const calls: Record<string, unknown>[] = [];
  let catalogueCalls = 0;
  let validationCalls = 0;
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      const path = new URL(req.url).pathname;
      if (path === '/models') {
        catalogueCalls++;
        if (options.catalogue) return options.catalogue();
        return Response.json({ connected: options.connected ?? true, models: options.availableModels ?? models, defaultModel: MODEL });
      }
      if (path === '/validate-model') {
        validationCalls++;
        const selection = await req.json<{ model: string }>();
        const model = (options.availableModels ?? models).find(value => value.id === selection.model);
        if (!(options.connected ?? true)) return Response.json({ error: { code: 'chatgpt_not_connected' } }, { status: 409 });
        if (!model) return Response.json({ error: { code: 'model_unavailable' } }, { status: 400 });
        return Response.json({ settings: selection, model });
      }
      if (path === '/responses') {
        calls.push(await req.json<Record<string, unknown>>());
        return options.response ? options.response(req) : completed();
      }
      throw new Error(`Unexpected fake ChatGPT endpoint: ${path}`);
    } }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls, catalogueCalls: () => catalogueCalls, validationCalls: () => validationCalls };
}
function completed(svg = SVG): Response {
  const event = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: svg }] }] } };
  return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function seed(state: DurableObjectState, name = 'Geometry bot'): Bot {
  const date = new Date().toISOString();
  const bot: Bot = { id: crypto.randomUUID(), name, instructions: 'Make useful geometry', runtime: 'pi', model: MODEL, createdAt: date, updatedAt: date };
  state.storage.sql.exec('INSERT INTO bots(id,data) VALUES(?,?)', bot.id, JSON.stringify(bot));
  return bot;
}
function coordinator(state: DurableObjectState, provider = fakeProvider(), files = bindings.FILES) {
  return new AvatarCoordinator(state, { ...bindings, FILES: files, CHATGPT: provider.namespace }, async () => {});
}
function expectClearedSnapshot(state: DurableObjectState, jobId: string) {
  const row = state.storage.sql.exec<{ bot: string; theme: string; output: string | null }>('SELECT bot,theme,output FROM avatar_jobs WHERE id=?', jobId).one();
  expect(row).toEqual({ bot: '{}', theme: '{}', output: null });
}
async function theme(c: AvatarCoordinator, name = 'Angular', kind: AvatarTheme['kind'] = 'vector', model = MODEL) {
  const response = await call(c, '/avatar-themes', 'POST', { operationId: crypto.randomUUID(), name, kind, model, prompt: `${name} shared design` });
  expect(response.status).toBe(201);
  return (await response.json<{ theme: AvatarTheme }>()).theme;
}
async function select(c: AvatarCoordinator, themeId: string) {
  const response = await call(c, '/avatar-settings', 'PUT', { operationId: crypto.randomUUID(), themeId });
  expect(response.status).toBe(200);
  return response.json<AvatarSettings>();
}
async function generate(c: AvatarCoordinator, botId?: string, operationId = crypto.randomUUID()) {
  const response = await call(c, '/avatar-generations', 'POST', { operationId, ...(botId ? { botId } : {}) });
  expect(response.status).toBe(202);
  return (await response.json<{ jobs: AvatarJob[] }>()).jobs;
}

// All provider calls below are deterministic in-process stubs. API's normal
// namespace is deliberately disconnected: no OAuth, cloud computer or inference.
describe('avatar HTTP boundary', () => {
  it('authenticates every avatar route and rejects unknown bots and per-bot theme overrides', async () => {
    const missing = crypto.randomUUID();
    for (const [path, method, body] of [
      ['/v1/avatar-settings', 'GET', undefined], ['/v1/avatar-settings', 'PUT', { themeId: missing, operationId: 'unauth-select' }],
      ['/v1/avatar-themes', 'POST', { name: 'Test', kind: 'vector', prompt: 'Test', model: MODEL, operationId: 'unauth-theme' }],
      ['/v1/avatar-generations', 'POST', { operationId: 'unauth-generate' }], ['/v1/avatar-models', 'GET', undefined],
      [`/v1/bots/${missing}/avatar`, 'GET', undefined],
    ] as const) await expectError(await api(path, method, body, false), 401, 'unauthorized');
    await expectError(await api(`/v1/bots/${missing}/avatar`), 404, 'not_found');
    await expectError(await api('/v1/avatar-generations', 'POST', { botId: missing, operationId: crypto.randomUUID() }), 404, 'not_found');
    const created = await api('/v1/bots', 'POST', { name: 'No individual theme' });
    expect(created.status).toBe(201);
    const { bot } = await created.json<{ bot: Bot }>();
    await expectError(await api(`/v1/bots/${bot.id}`, 'PATCH', { avatarThemeId: missing }), 400, 'invalid_request');
    await expectError(await api('/v1/avatar-generations', 'POST', { botId: bot.id, themeId: missing, operationId: crypto.randomUUID() }), 400, 'invalid_request');
    await expectError(await api('/v1/avatar-settings', 'PUT', { botId: bot.id, themeId: missing, operationId: crypto.randomUUID() }), 400, 'invalid_request');
    await expectError(await api(`/v1/bots/${bot.id}/avatar`), 404, 'avatar_not_ready');
  });

  it('persists custom theme receipts and monotonic switches without generating implicitly', async () => {
    const initial = await (await api('/v1/avatar-settings')).json<AvatarSettings>();
    expect(initial.selection?.revision).toBeGreaterThanOrEqual(1);
    const operationId = crypto.randomUUID();
    const input = { operationId, name: 'Durable custom theme', kind: 'vector', model: MODEL, prompt: 'Shared warm angular silhouettes' };
    const first = await api('/v1/avatar-themes', 'POST', input);
    expect(first.status).toBe(201);
    const receipt = await first.json<{ theme: AvatarTheme }>();
    expect(await (await api('/v1/avatar-themes', 'POST', input)).json()).toEqual(receipt);
    await expectError(await api('/v1/avatar-themes', 'POST', { ...input, prompt: 'Different' }), 409, 'operation_conflict');
    const switchId = crypto.randomUUID();
    const switched = await (await api('/v1/avatar-settings', 'PUT', { operationId: switchId, themeId: receipt.theme.id })).json<AvatarSettings>();
    expect(switched.selection).toEqual({ themeId: receipt.theme.id, revision: initial.selection!.revision + 1 });
    expect(switched.jobs).toEqual(initial.jobs);
    const same = await (await api('/v1/avatar-settings', 'PUT', { operationId: crypto.randomUUID(), themeId: receipt.theme.id })).json<AvatarSettings>();
    expect(same.selection).toEqual(switched.selection);
    await expectError(await api('/v1/avatar-settings', 'PUT', { operationId: switchId, themeId: initial.selection!.themeId }), 409, 'operation_conflict');
    const switchedBack = await (await api('/v1/avatar-settings', 'PUT', { operationId: crypto.randomUUID(), themeId: initial.selection!.themeId })).json<AvatarSettings>();
    expect(switchedBack.selection!.revision).toBe(switched.selection!.revision + 1);
    // Replaying a prior switch returns current settings without applying an old selection.
    expect(await (await api('/v1/avatar-settings', 'PUT', { operationId: switchId, themeId: receipt.theme.id })).json()).toEqual(switchedBack);
    expect((await (await api('/v1/avatar-settings')).json<AvatarSettings>()).selection).toEqual(switchedBack.selection);
    const catalog = await (await api('/v1/avatar-models')).json();
    expect(catalog).toMatchObject({ connected: false, vectorModels: [], imageModels: [], imageAvailable: false });
    await expectError(await api('/v1/avatar-generations', 'POST', { operationId: crypto.randomUUID() }), 409, 'chatgpt_not_connected');
  });
});

describe('owner-local AvatarCoordinator journals', () => {
  it('honors supplied vector global preconditions without permitting a per-bot model override',async()=>{
    await runInDurableObject(stub(),async(_instance,state)=>{
      const provider=fakeProvider(),c=coordinator(state,provider),bot=seed(state),confirmed=c.selection()!;
      const input={operationId:crypto.randomUUID(),botId:bot.id,expectedThemeId:confirmed.themeId,expectedRevision:confirmed.revision};
      await select(c,(await theme(c,'Changed vector')).id);
      await expectError(await call(c,'/avatar-generations','POST',input),409,'avatar_theme_changed');
      expect(c.settings().jobs).toEqual([]);expect(provider.catalogueCalls()).toBe(0);expect(provider.calls).toHaveLength(0);
      await expectError(await call(c,'/avatar-generations','POST',{...input,expectedThemeId:c.selection()!.themeId}),409,'avatar_theme_changed');
      await expectError(await call(c,'/avatar-generations','POST',{...input,expectedRevision:0}),400,'invalid_request');
      await expectError(await call(c,'/avatar-generations','POST',{...input,expectedThemeId:'not-a-uuid'}),400,'invalid_request');
      await expectError(await call(c,'/avatar-generations','POST',{...input,expectedRevision:undefined}),409,'avatar_theme_confirmation_required');
      await expectError(await call(c,'/avatar-generations','POST',{...input,model:MODEL}),400,'invalid_request');
      const fresh={...input,expectedThemeId:c.selection()!.themeId,expectedRevision:c.selection()!.revision};
      expect((await call(c,'/avatar-generations','POST',fresh)).status).toBe(202);
      const ids=c.settings().jobs.map(job=>job.id);await select(c,confirmed.themeId);
      const replay=await call(c,'/avatar-generations','POST',fresh);expect(replay.status).toBe(202);
      expect((await replay.json<{jobs:AvatarJob[]}>()).jobs.map(job=>job.id)).toEqual(ids);expect(provider.calls).toHaveLength(0);
    });
  });
  it('isolates themes, selection, jobs and bot membership between workspace objects', async () => {
    const left = stub(), right = stub();
    let leftTheme!: string, leftBot!: string, leftSelection!: AvatarSettings['selection'];
    await runInDurableObject(left, async (_instance, state) => {
      const c = coordinator(state), bot = seed(state, 'Owner A');
      leftBot = bot.id; leftTheme = (await theme(c, 'Owner A private theme')).id;
      leftSelection = (await select(c, leftTheme)).selection;
      await generate(c, bot.id);
    });
    await runInDurableObject(right, async (_instance, state) => {
      const c = coordinator(state);
      expect(c.settings().themes.some(t => t.id === leftTheme)).toBe(false);
      expect(c.selection()).not.toEqual(leftSelection);
      expect(c.settings().jobs).toEqual([]);
      expect(c.settings().avatars).toEqual([]);
      await expectError(await call(c, '/avatar-settings', 'PUT', { themeId: leftTheme, operationId: crypto.randomUUID() }), 404, 'avatar_theme_not_found');
      await expectError(await call(c, '/avatar-generations', 'POST', { botId: leftBot, operationId: crypto.randomUUID() }), 404, 'not_found');
      await expectError(await call(c, `/avatar/${leftBot}`), 404, 'not_found');
    });
    await runInDurableObject(left, async (_instance, state) => {
      const recovered = coordinator(state);
      expect(recovered.selection()).toEqual(leftSelection);
      expect(recovered.settings().jobs).toHaveLength(1);
    });
  });

  it('snapshots one global theme and bot identity, deduplicates all-bot receipts and supports per-bot regeneration', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const provider = fakeProvider(), c = coordinator(state, provider);
      const a = seed(state, 'Alpha'), b = seed(state, 'Beta');
      const chosen = await theme(c);
      const settings = await select(c, chosen.id);
      const operationId = crypto.randomUUID();
      const jobs = await generate(c, undefined, operationId);
      expect(jobs.map(j => j.botId)).toEqual([a.id, b.id]);
      for (const job of jobs) expect(job).toMatchObject({ themeId: chosen.id, revision: settings.selection!.revision, status: 'queued', operationId });
      expect(provider.calls).toHaveLength(0);
      const addedLater = seed(state, 'Added after admission');
      expect(await generate(c, undefined, operationId)).toEqual(jobs);
      expect(jobs.some(j => j.botId === addedLater.id)).toBe(false);
      expect(c.settings().jobs).toHaveLength(2);
      await expectError(await call(c, '/avatar-generations', 'POST', { botId: a.id, operationId }), 409, 'operation_conflict');
      for (const override of [{ themeId: chosen.id }, { prompt: 'Ignore shared theme' }, { model: 'different-model' }, { botIds: [a.id] }]) {
        await expectError(await call(c, '/avatar-generations', 'POST', { operationId: crypto.randomUUID(), ...override }), 400, 'invalid_request');
      }
      // A later registry edit cannot change an already accepted inference input.
      state.storage.sql.exec('UPDATE bots SET data=? WHERE id=?', JSON.stringify({ ...a, name: 'Changed later', instructions: 'Changed later' }), a.id);
      await c.alarm(); await c.alarm();
      expect(provider.calls).toHaveLength(2);
      const firstInput = provider.calls[0].input as { content: { text: string }[] }[];
      expect(JSON.parse(firstInput[0].content[0].text)).toEqual({ theme: chosen.prompt, botName: a.name, botInstructions: a.instructions });
      expect(provider.calls[0]).toMatchObject({ model: chosen.model, store: false, stream: true });
      expect(c.settings().avatars).toHaveLength(2);
      for (const job of jobs) expectClearedSnapshot(state, job.id);
      const oldA = c.settings().avatars.find(v => v.botId === a.id)!;
      const oldB = c.settings().avatars.find(v => v.botId === b.id)!;
      const single = await generate(c, a.id);
      expect(single).toHaveLength(1); expect(single[0].botId).toBe(a.id);
      await c.alarm();
      expect(provider.calls).toHaveLength(3);
      expect(c.settings().avatars.find(v => v.botId === b.id)).toEqual(oldB);
      expect(c.settings().avatars.find(v => v.botId === a.id)!.artifactId).not.toBe(oldA.artifactId);
      const oldKey = `bots/${a.id}/avatars/${oldA.artifactId}`;
      expect(state.storage.sql.exec<{ key: string }>('SELECT key FROM avatar_gc WHERE key=?', oldKey).one().key).toBe(oldKey);
      const recovered = coordinator(state, provider);
      expect(recovered.nextAlarm()).toBeDefined();
      await recovered.alarm();
      expect(await bindings.FILES.get(oldKey)).toBeNull();
      expect(state.storage.sql.exec('SELECT key FROM avatar_gc WHERE key=?', oldKey).toArray()).toEqual([]);
      expect((await generate(recovered, undefined, operationId)).map(j => j.id)).toEqual(jobs.map(j => j.id));
      expect((await generate(c, undefined, operationId)).every(j => j.status === 'completed')).toBe(true);
      expect(provider.calls).toHaveLength(3);
    });
  });

  it('does not publish a stale in-flight result after a new global switch', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let first = true;
      const provider = fakeProvider({ response: async () => {
        if (first) { first = false; enter(); await gate; }
        return completed();
      } });
      const c = coordinator(state, provider), bot = seed(state);
      const old = (await generate(c, bot.id))[0];
      const running = c.alarm();
      await entered;
      expect(c.settings().jobs[0].status).toBe('running');
      const changed = await theme(c, 'New consistent theme');
      const selected = await select(c, changed.id);
      const newer = (await generate(c, bot.id))[0];
      release(); await running;
      expect(c.settings().jobs.find(j => j.id === old.id)!.status).toBe('obsolete');
      expectClearedSnapshot(state, old.id);
      expect(c.settings().avatars).toEqual([]);
      expect((await bindings.FILES.list({ prefix: `bots/${bot.id}/avatars/` })).objects).toEqual([]);
      await c.alarm();
      expect(c.settings().avatars[0]).toMatchObject({ themeId: changed.id, revision: selected.selection!.revision, status: 'ready' });
      expect(c.settings().jobs.find(j => j.id === newer.id)!.status).toBe('completed');
      expect(provider.calls).toHaveLength(2);
      // Switching retains the validated previous image until replacement, without inference.
      await select(c, old.themeId);
      expect(c.settings().avatars[0].status).toBe('obsolete');
      const previousImage=await call(c, `/avatar/${bot.id}`);
      expect(previousImage.status).toBe(200);
      expect(await previousImage.text()).toBe(sanitizeAvatarSvg(SVG));
      expect(provider.calls).toHaveLength(2);
    });
  });

  for (const stage of ['get', 'body'] as const) for (const change of ['switch', 'replacement', 'delete'] as const)
    it(`fences ${stage} read after ${change}, but retains an obsolete validated image`, async () => {
      await runInDurableObject(stub(), async (_instance, state) => {
        const provider=fakeProvider(), bot=seed(state), initial=coordinator(state,provider);
        await generate(initial,bot.id);await initial.alarm();
        const old=initial.settings().avatars[0];
        let enter!:()=>void,release!:()=>void;
        const entered=new Promise<void>(resolve=>{enter=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;});
        const files=new Proxy(bindings.FILES,{get(target,property){
          if(property==='get')return async (...args:Parameters<R2Bucket['get']>)=>{
            const object=await target.get(...args);
            if(stage==='get'){enter();await gate;return object;}
            return object?new Proxy(object,{get(value,key){
              if(key==='text')return async ()=>{const text=await value.text();enter();await gate;return text;};
              const member=Reflect.get(value,key,value);return typeof member==='function'?member.bind(value):member;
            }}):null;
          };
          const member=Reflect.get(target,property,target);return typeof member==='function'?member.bind(target):member;
        }});
        const reader=coordinator(state,provider,files), reading=call(reader,`/avatar/${bot.id}`);
        await entered;
        if(change==='switch')await select(initial,(await theme(initial,'Retain prior image')).id);
        if(change==='replacement'){await generate(initial,bot.id);await initial.alarm();}
        if(change==='delete'){state.storage.sql.exec('DELETE FROM bots WHERE id=?',bot.id);initial.forgetBot(bot.id);await initial.drainBot(bot.id);}
        release();const result=await reading;
        if(change==='switch'){
          expect(result.status).toBe(200);expect(await result.text()).toBe(sanitizeAvatarSvg(SVG));
          expect(initial.settings().avatars[0]).toMatchObject({artifactId:old.artifactId,status:'obsolete'});
        }else await expectError(result,404,'avatar_not_ready');
      });
    });

  it('revalidates private immutable ETags and never returns a conditional hit without membership or valid bytes', async () => {
    await runInDurableObject(stub(),async(_instance,state)=>{
      const c=coordinator(state),bot=seed(state);await generate(c,bot.id);await c.alarm();
      const avatar=c.settings().avatars[0],path=`/avatar/${bot.id}`;
      const first=await call(c,path),etag=first.headers.get('etag')!;
      const conditional=()=>new Request(`https://workspace${path}`,{headers:{'if-none-match':`W/${etag}`}});
      const cached=await c.fetch(conditional());expect(cached.status).toBe(304);expect(await cached.text()).toBe('');
      await select(c,(await theme(c,'Different global theme')).id);
      expect((await c.fetch(conditional())).status).toBe(304);
      await bindings.FILES.put(`bots/${bot.id}/avatars/${avatar.artifactId}`,'<svg><script/></svg>');
      try{await c.fetch(conditional());throw new Error('invalid bytes accepted');}catch(error){expect(error).toMatchObject({code:'avatar_svg_invalid'});}
      state.storage.sql.exec('DELETE FROM bots WHERE id=?',bot.id);c.forgetBot(bot.id);
      try{await c.fetch(conditional());throw new Error('deleted bot accepted');}catch(error){expect(error).toMatchObject({code:'not_found'});}
    });
  });

  it('interrupts a recovered running dispatch instead of replaying inference', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const provider = fakeProvider(), c = coordinator(state, provider), bot = seed(state);
      const operationId = crypto.randomUUID(), job = (await generate(c, bot.id, operationId))[0];
      const running: AvatarJob = { ...job, status: 'running' };
      state.storage.sql.exec('UPDATE avatar_jobs SET data=?,next_at=0 WHERE id=?', JSON.stringify(running), job.id);
      const recovered = coordinator(state, provider);
      expect(recovered.settings().jobs[0]).toMatchObject({ id: job.id, status: 'interrupted', error: { code: 'avatar_generation_interrupted' } });
      expectClearedSnapshot(state, job.id);
      await recovered.alarm(); await recovered.alarm();
      expect(provider.calls).toHaveLength(0);
      expect(recovered.nextAlarm()).toBeUndefined();
      expect((await generate(recovered, bot.id, operationId))[0].status).toBe('interrupted');
      expect(recovered.settings().jobs).toHaveLength(1);
      const explicit = await generate(recovered, bot.id);
      expect(explicit[0].id).not.toBe(job.id);
      await recovered.alarm();
      expect(provider.calls).toHaveLength(1);
      expect(recovered.settings().jobs[0].status).toBe('completed');
    });
  });

  it('never replays a live uncertain running marker without durable output',async()=>{
    await runInDurableObject(stub(),async(_instance,state)=>{
      const provider=fakeProvider(),c=coordinator(state,provider),bot=seed(state),job=(await generate(c,bot.id))[0];
      state.storage.sql.exec('UPDATE avatar_jobs SET data=?,next_at=0 WHERE id=?',JSON.stringify({...job,status:'running'}),job.id);
      // No new coordinator/constructor: alarm itself must fence uncertain dispatch.
      await c.alarm();await c.alarm();expect(provider.calls).toHaveLength(0);
      expect(c.settings().jobs[0]).toMatchObject({id:job.id,status:'interrupted',error:{code:'avatar_generation_interrupted'}});
      expectClearedSnapshot(state,job.id);
    });
  });

  it('recovers journaled sanitized output to R2 without a new inference call', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const provider = fakeProvider(), c = coordinator(state, provider), bot = seed(state);
      const job = (await generate(c, bot.id))[0], safe = sanitizeAvatarSvg(SVG);
      state.storage.sql.exec('UPDATE avatar_jobs SET data=?,output=?,next_at=0 WHERE id=?', JSON.stringify({ ...job, status: 'running' }), safe, job.id);
      const artifact = state.storage.sql.exec<{ artifact_id: string }>('SELECT artifact_id FROM avatar_jobs WHERE id=?', job.id).one().artifact_id;
      // Model catalogues also must not be revisited during publication recovery.
      const catalogsBefore = provider.catalogueCalls(), validationsBefore = provider.validationCalls();
      const recovered = coordinator(state, provider);
      await recovered.alarm(); await recovered.alarm();
      expect(provider.calls).toHaveLength(0);
      expect(provider.catalogueCalls()).toBe(catalogsBefore);
      expect(provider.validationCalls()).toBe(validationsBefore);
      expect(recovered.settings().jobs[0].status).toBe('completed');
      expect(recovered.settings().avatars[0].artifactId).toBe(artifact);
      const object = await bindings.FILES.get(`bots/${bot.id}/avatars/${artifact}`);
      expect(await object!.text()).toBe(safe);
      expect(object!.httpMetadata?.contentType).toBe('image/svg+xml');
    });
  });

  it('fences a deleted bot while inference is in flight, erases snapshots and drains the journal', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const provider = fakeProvider({ response: async () => { enter(); await gate; return completed(); } });
      const c = coordinator(state, provider), bot = seed(state, 'Private deleted identity');
      const operationId = crypto.randomUUID(), job = (await generate(c, bot.id, operationId))[0];
      const running = c.alarm(); await entered;
      state.storage.sql.exec('DELETE FROM bots WHERE id=?', bot.id);
      c.forgetBot(bot.id);
      const fenced = state.storage.sql.exec<{ bot: string; output: string | null; data: string }>('SELECT bot,output,data FROM avatar_jobs WHERE id=?', job.id).one();
      expect(fenced.bot).toBe('{}'); expect(fenced.output).toBeNull();
      expect(JSON.parse(fenced.data).status).toBe('obsolete');
      const drained = c.drainBot(bot.id);
      release(); await running; await drained;
      expect(c.settings().avatars).toEqual([]);
      expect(c.settings().jobs).toEqual([]);
      expect((await bindings.FILES.list({ prefix: `bots/${bot.id}/avatars/` })).objects).toEqual([]);
      await expectError(await call(c, `/avatar/${bot.id}`), 404, 'not_found');
      await expectError(await call(c, '/avatar-generations', 'POST', { botId: bot.id, operationId: crypto.randomUUID() }), 404, 'not_found');
      expect(await generate(c, bot.id, operationId)).toEqual([]);
      expect(provider.calls).toHaveLength(1);
    });
  });

  it('reports disconnected, unavailable text model and unsupported image generation without inference', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const provider = fakeProvider({ connected: false }), c = coordinator(state, provider), bot = seed(state);
      await expectError(await call(c, '/avatar-generations', 'POST', { botId: bot.id, operationId: crypto.randomUUID() }), 409, 'chatgpt_not_connected');
      expect(c.settings().jobs).toEqual([]); expect(provider.calls).toHaveLength(0);
      const image = await theme(c, 'Image desired', 'image', 'gpt-image-2.5');
      await select(c, image.id);
      const discoveries = provider.catalogueCalls();
      await expectError(await call(c, '/avatar-generations', 'POST', { botId: bot.id, operationId: crypto.randomUUID(), expectedThemeId: c.selection()!.themeId, expectedRevision: c.selection()!.revision }), 422, 'avatar_image_unavailable');
      expect(provider.catalogueCalls()).toBe(discoveries);
      expect(provider.calls).toHaveLength(0); expect(c.settings().jobs).toEqual([]);
      const connected = fakeProvider(), next = coordinator(state, connected);
      const unavailable = await theme(next, 'Unavailable model', 'vector', 'not-an-account-model');
      await select(next, unavailable.id);
      await expectError(await call(next, '/avatar-generations', 'POST', { botId: bot.id, operationId: crypto.randomUUID() }), 422, 'avatar_model_unavailable');
      expect(connected.calls).toHaveLength(0); expect(next.settings().jobs).toEqual([]);
      expect(await (await call(next, '/avatar-models')).json()).toMatchObject({ connected: true, vectorModels: models, imageModels: [], imageAvailable: false });
    });
  });

  it('rejects malicious generated SVG before publication and does not retry the paid dispatch', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const malicious = '<svg viewBox="0 0 128 128"><script>private-provider-content</script></svg>';
      const provider = fakeProvider({ response: async () => completed(malicious) });
      const c = coordinator(state, provider), bot = seed(state);
      const operationId = crypto.randomUUID(); await generate(c, bot.id, operationId);
      await c.alarm(); await c.alarm();
      expect(c.settings().jobs[0]).toMatchObject({ status: 'failed', error: { code: 'avatar_svg_invalid' } });
      expectClearedSnapshot(state, c.settings().jobs[0].id);
      expect(JSON.stringify(c.settings())).not.toContain('private-provider-content');
      expect(c.settings().avatars).toEqual([]);
      expect((await bindings.FILES.list({ prefix: `bots/${bot.id}/avatars/` })).objects).toEqual([]);
      expect((await generate(c, bot.id, operationId))[0].status).toBe('failed');
      expect(provider.calls).toHaveLength(1);
      const recovered = coordinator(state, provider); await recovered.alarm();
      expect(provider.calls).toHaveLength(1);
    });
  });
  it('returns the concurrent same-operation receipt after delayed discovery and a theme switch', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let discovery = 0;
      const provider = fakeProvider({ catalogue: async () => {
        if (++discovery === 1) {
          enter(); await gate;
          // Even a disconnected late catalogue cannot invalidate a saved receipt.
          return Response.json({ connected: false, models: [], defaultModel: MODEL });
        }
        return Response.json({ connected: true, models, defaultModel: MODEL });
      } });
      const c = coordinator(state, provider), bot = seed(state);
      const operationId = crypto.randomUUID();
      const delayed = call(c, '/avatar-generations', 'POST', { operationId, botId: bot.id });
      await entered;
      const admitted = (await generate(c, bot.id, operationId))[0];
      const changed = await theme(c, 'Switch during discovery'); await select(c, changed.id);
      release();
      const replay = await delayed;
      expect(replay.status).toBe(202);
      expect((await replay.json<{ jobs: AvatarJob[] }>()).jobs).toEqual([{ ...admitted, ...c.settings().jobs[0] }]);
      expect(c.settings().jobs).toHaveLength(1);
      expect(c.settings().jobs[0]).toMatchObject({ id: admitted.id, operationId, status: 'obsolete', themeId: admitted.themeId });
      expect(c.selection()!.themeId).toBe(changed.id);
      expectClearedSnapshot(state, admitted.id);
      expect(provider.calls).toHaveLength(0); expect(provider.validationCalls()).toBe(0);
    });
  });

  for (const supersession of ['switch', 'new-generation'] as const) it(`recovers GC of a remotely saved PUT with a lost receipt after ${supersession}`, async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let enter!: () => void, release!: () => void;
      const uploaded = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const provider = fakeProvider(), bot = seed(state, 'Private candidate identity');
      let candidate = '', firstPut = true, failDeletion = true;
      const files = new Proxy(bindings.FILES, { get(target, property) {
        if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
          if (!firstPut) return target.put(...args);
          firstPut = false; candidate = args[0];
          // The candidate must be durable before R2 starts accepting the bytes.
          expect(state.storage.sql.exec<{ key: string }>('SELECT key FROM avatar_candidates WHERE key=?', candidate).one().key).toBe(candidate);
          await target.put(...args); enter(); await gate;
          throw new Error('Lost receipt after successful remote PUT');
        };
        if (property === 'delete') return async (key: string | string[]) => {
          if (key === candidate && failDeletion) { failDeletion = false; throw new Error('Transient R2 delete failure'); }
          return target.delete(key);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const c = coordinator(state, provider, files);
      const old = (await generate(c, bot.id))[0], running = c.alarm();
      await uploaded;
      expect(await bindings.FILES.head(candidate)).not.toBeNull();
      if (supersession === 'switch') await select(c, (await theme(c, 'New shared candidate theme')).id);
      const newer = (await generate(c, bot.id))[0];
      release(); await running;
      expect(c.settings().jobs.find(j => j.id === old.id)!.status).toBe('obsolete');
      expectClearedSnapshot(state, old.id);
      expect(state.storage.sql.exec('SELECT key FROM avatar_gc WHERE key=?', candidate).toArray()).toHaveLength(1);
      const recovered = coordinator(state, provider, files);
      expect(recovered.nextAlarm()).toBeDefined();
      await recovered.alarm();
      // A cleanup outage is journaled independently of the newer successful job.
      const garbage = state.storage.sql.exec<{ attempts: number; next_at: number }>('SELECT attempts,next_at FROM avatar_gc WHERE key=?', candidate).one();
      expect(garbage.attempts).toBe(1); expect(garbage.next_at).toBeGreaterThan(Date.now());
      expect(await bindings.FILES.head(candidate)).not.toBeNull();
      expect(recovered.settings().jobs.find(j => j.id === newer.id)!.status).toBe('completed');
      expect(provider.calls).toHaveLength(2);
      expectClearedSnapshot(state, newer.id);
      state.storage.sql.exec('UPDATE avatar_gc SET next_at=0 WHERE key=?', candidate);
      const cleanup = coordinator(state, provider);
      await cleanup.alarm();
      expect(await bindings.FILES.head(candidate)).toBeNull();
      expect(state.storage.sql.exec('SELECT key FROM avatar_candidates WHERE key=?', candidate).toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT key FROM avatar_gc WHERE key=?', candidate).toArray()).toEqual([]);
      expect(provider.calls).toHaveLength(2);
      expect(cleanup.settings().avatars[0]).toMatchObject({ botId: bot.id, themeId: newer.themeId, revision: newer.revision, status: 'ready' });
    });
  });

  it('drains another deleted bot without awaiting or aborting the active bot generation', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let enter!: () => void, release!: () => void, signal!: AbortSignal;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const provider = fakeProvider({ response: async request => { signal = request.signal; enter(); await gate; return completed(); } });
      const c = coordinator(state, provider), active = seed(state, 'Keep active'), removed = seed(state, 'Delete unrelated');
      await generate(c, active.id); await generate(c, removed.id);
      const running = c.alarm(); await entered;
      state.storage.sql.exec('DELETE FROM bots WHERE id=?', removed.id); c.forgetBot(removed.id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          c.drainBot(removed.id).then(() => 'drained'),
          new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked on unrelated generation'), 1000); }),
        ]);
        expect(result).toBe('drained'); expect(signal.aborted).toBe(false);
        expect(c.settings().jobs.some(j => j.botId === removed.id)).toBe(false);
        expect(c.settings().jobs.find(j => j.botId === active.id)!.status).toBe('running');
      } finally { if (timer !== undefined) clearTimeout(timer); release(); await running; }
      expect(c.settings().avatars[0]).toMatchObject({ botId: active.id, status: 'ready' });
      expect(provider.calls).toHaveLength(1);
    });
  });

  it('Workspace deletion shuts down A and finishes without awaiting B avatar generation',async()=>{
    await runInDurableObject(stub(),async(instance,state)=>{
      let enter!:()=>void,release!:()=>void,signal!:AbortSignal;
      const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      const provider=fakeProvider({response:async request=>{signal=request.signal;enter();await gate;return completed();}});
      const c=coordinator(state,provider),a=seed(state,'Stop promptly'),b=seed(state,'Independent generation');
      const workspace=instance as unknown as {avatars:AvatarCoordinator;fetch(request:Request):Promise<Response>},original=workspace.avatars;
      workspace.avatars=c;
      await generate(c,b.id);const running=c.alarm();await entered;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const result=await Promise.race([workspace.fetch(request(`/${a.id}`,'DELETE')),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);
        expect(result).not.toBeNull();expect(result!.status).toBe(200);expect(signal.aborted).toBe(false);
        const runtime=bindings.BOT.get(bindings.BOT.idFromName(`owner:${a.id}`));
        await runInDurableObject(runtime,(_bot,botState)=>{
          expect(botState.storage.sql.exec<{bot_id:string}>('SELECT bot_id FROM bot_deletion').one().bot_id).toBe(a.id);
        });
        expect(c.settings().jobs[0]).toMatchObject({botId:b.id,status:'running'});
      }finally{if(timer!==undefined)clearTimeout(timer);release();await running;workspace.avatars=original;}
      expect(c.settings().avatars[0]).toMatchObject({botId:b.id,status:'ready'});
    });
  });

});

it('serves authenticated sanitized R2 SVG with restrictive headers and cleans avatars during API deletion', async () => {
  const response = await api('/v1/bots', 'POST', { name: 'Safe avatar download' });
  expect(response.status).toBe(201);
  const { bot } = await response.json<{ bot: Bot }>();
  const registry = bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
  let artifact!: string;
  await runInDurableObject(registry, async (_instance, state) => {
    const c = coordinator(state);
    await generate(c, bot.id); await c.alarm();
    artifact = c.settings().avatars.find(a => a.botId === bot.id)!.artifactId;
  });
  const key = `bots/${bot.id}/avatars/${artifact}`;
  await expectError(await api(`/v1/bots/${bot.id}/avatar`, 'GET', undefined, false), 401, 'unauthorized');
  const download = await api(`/v1/bots/${bot.id}/avatar`);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('image/svg+xml');
  expect(download.headers.get('content-disposition')).toBe(`attachment; filename="avatar-${artifact}.svg"`);
  expect(download.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
  expect(download.headers.get('etag')).toBe(`"avatar-${artifact}"`);
  expect(download.headers.get('vary')).toBe('Authorization, Cookie');
  expect(download.headers.get('x-timber-avatar-variant')).toBe('original');
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  expect(download.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; style-src 'none'");
  expect(download.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(await download.text()).toBe(sanitizeAvatarSvg(SVG));
  const conditional=await api(`/v1/bots/${bot.id}/avatar`,'GET',undefined,true,{'if-none-match':`"avatar-${artifact}"`});
  expect(conditional.status).toBe(304);expect(await conditional.text()).toBe('');
  expect(conditional.headers.get('etag')).toBe(`"avatar-${artifact}"`);
  expect(conditional.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
  expect(conditional.headers.get('vary')).toBe('Authorization, Cookie');
  expect((await api(`/v1/bots/${bot.id}/avatar`,'GET',undefined,true,{'if-none-match':'"different"'})).status).toBe(200);
  await expectError(await api(`/v1/bots/${bot.id}/avatar`,'GET',undefined,false,{'if-none-match':`"avatar-${artifact}"`}),401,'unauthorized');
  const malicious = '<svg viewBox="0 0 128 128" onload="private-malicious-r2"><path d="M0 0L1 1"/></svg>';
  await bindings.FILES.put(key, malicious, { httpMetadata: { contentType: 'image/svg+xml' } });
  const rejected = await api(`/v1/bots/${bot.id}/avatar`);
  expect(rejected.status).toBe(502);
  const diagnostic = await rejected.text();
  expect(JSON.parse(diagnostic)).toMatchObject({ error: { code: 'avatar_svg_invalid' } });
  expect(diagnostic).not.toContain('private-malicious-r2'); expect(diagnostic).not.toContain('<svg');
  // R2's metadata cannot turn avatar bytes into executable HTML either.
  await bindings.FILES.put(key, SVG, { httpMetadata: { contentType: 'text/html' } });
  expect((await api(`/v1/bots/${bot.id}/avatar`)).headers.get('content-type')).toBe('image/svg+xml');
  expect((await api(`/v1/bots/${bot.id}`, 'DELETE')).status).toBe(200);
  expect(await bindings.FILES.get(key)).toBeNull();
  await runInDurableObject(registry, (_instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM bot_avatars WHERE bot_id=?', bot.id).one().n).toBe(0);
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM avatar_jobs WHERE bot_id=?', bot.id).one().n).toBe(0);
  });
  await expectError(await api(`/v1/bots/${bot.id}/avatar`), 404, 'not_found');
});
// Mock-only Images API. The inert fixture key never reaches a network transport.
describe('explicit Image API coordinator admission and PNG publication',()=>{
  const IMAGE_MODEL='gpt-image-2.5-sunburst';
  const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==';
  const imageCoordinator=(state:DurableObjectState,provider=fakeProvider({connected:false}),files=bindings.FILES)=>
    new AvatarCoordinator(state,{...bindings,CHATGPT:provider.namespace,FILES:files,OPENAI_API_KEY:'inert-avatar-test-key'},async()=>{});
  const imageInput=(c:AvatarCoordinator,botId?:string,confirmedCount=1,operationId=crypto.randomUUID())=>({operationId,expectedThemeId:c.selection()!.themeId,expectedRevision:c.selection()!.revision,...(botId?{botId}:{}),confirmedCount,acknowledgeApiBilling:true});
  function imageFetch(output=PNG){
    const calls:Record<string,unknown>[]=[];
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      expect(String(input)).toBe('https://api.openai.com/v1/images/generations');
      calls.push(JSON.parse(init!.body as string));
      return Response.json({data:[{b64_json:output}]});
    });return{calls,restore:()=>spy.mockRestore()};
  }
  it('never admits or bills Sunburst consent after Flare is selected before POST or a no-receipt resend',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        const provider=fakeProvider({connected:false}),c=imageCoordinator(state,provider),bot=seed(state);
        const sunburst=await theme(c,'Sunburst consent','image',IMAGE_MODEL);
        const flare=await theme(c,'Flare selected','image','gpt-image-2.5-flare');
        await select(c,sunburst.id);const input=imageInput(c,bot.id);
        await select(c,flare.id);const discoveries=provider.catalogueCalls();
        for(let attempt=0;attempt<2;attempt++){
          await expectError(await call(c,'/avatar-generations','POST',input),409,'avatar_theme_changed');
          await c.alarm();expect(c.settings().jobs).toEqual([]);expect(mock.calls).toHaveLength(0);
        }
        expect(provider.catalogueCalls()).toBe(discoveries);expect(provider.calls).toHaveLength(0);
        expect(state.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM avatar_receipts WHERE operation_id=?',input.operationId).one().n).toBe(0);
        // Switching back to the same immutable theme still invalidates old revision consent.
        await select(c,sunburst.id);
        await expectError(await call(c,'/avatar-generations','POST',input),409,'avatar_theme_changed');
        await expectError(await call(c,'/avatar-generations','POST',{operationId:crypto.randomUUID(),botId:bot.id,confirmedCount:1,acknowledgeApiBilling:true}),409,'avatar_theme_confirmation_required');
        await expectError(await call(c,'/avatar-generations','POST',{...imageInput(c,bot.id),expectedRevision:undefined}),409,'avatar_theme_confirmation_required');
        expect(c.settings().jobs).toEqual([]);expect(mock.calls).toHaveLength(0);
      });
    }finally{mock.restore();}
  });
  it('rejects a Sunburst-to-Flare switch while discovery yields before admitting any image jobs',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
        const provider=fakeProvider({catalogue:async()=>{enter();await gate;return Response.json({connected:false,models:[],defaultModel:MODEL});}});
        const c=imageCoordinator(state,provider),bot=seed(state);
        await select(c,(await theme(c,'Sunburst race','image',IMAGE_MODEL)).id);
        const flare=await theme(c,'Flare race','image','gpt-image-2.5-flare');
        const admission=call(c,'/avatar-generations','POST',imageInput(c,bot.id));await entered;
        await select(c,flare.id);release();await expectError(await admission,409,'avatar_theme_changed');
        await c.alarm();expect(c.settings().jobs).toEqual([]);expect(mock.calls).toHaveLength(0);
      });
    }finally{mock.restore();}
  });
  it('replays an existing receipt before mismatch/provider validation after Sunburst switches to Flare',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        const provider=fakeProvider({connected:false}),c=imageCoordinator(state,provider),bot=seed(state);
        await select(c,(await theme(c,'Sunburst confirmed','image',IMAGE_MODEL)).id);
        const input=imageInput(c,bot.id),admitted=await call(c,'/avatar-generations','POST',input);
        expect(admitted.status).toBe(202);const {jobs}=await admitted.json<{jobs:AvatarJob[]}>();
        await select(c,(await theme(c,'Flare now','image','gpt-image-2.5-flare')).id);
        const discoveries=provider.catalogueCalls();
        // Configuration can also disappear: receipt replay still needs no discovery/inference.
        const recovered=new AvatarCoordinator(state,{...bindings,CHATGPT:provider.namespace,OPENAI_API_KEY:undefined},async()=>{});
        const replay=await call(recovered,'/avatar-generations','POST',input);expect(replay.status).toBe(202);
        const replayed=(await replay.json<{jobs:AvatarJob[]}>()).jobs;expect(replayed.map(job=>job.id)).toEqual(jobs.map(job=>job.id));expect(replayed[0].status).toBe('obsolete');
        await expectError(await call(recovered,'/avatar-generations','POST',{...input,expectedThemeId:c.selection()!.themeId,expectedRevision:c.selection()!.revision}),409,'operation_conflict');
        await c.alarm();expect(c.settings().jobs).toHaveLength(1);expect(mock.calls).toHaveLength(0);expect(provider.catalogueCalls()).toBe(discoveries);
      });
    }finally{mock.restore();}
  });
  it('requires separate API billing and current batch count, independent from SIWC connection',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        const c=imageCoordinator(state),a=seed(state,'Image A'),b=seed(state,'Image B');
        await select(c,(await theme(c,'Shared raster','image',IMAGE_MODEL)).id);
        await expectError(await call(c,'/avatar-generations','POST',{...imageInput(c,a.id),acknowledgeApiBilling:undefined}),409,'avatar_api_billing_confirmation_required');
        await expectError(await call(c,'/avatar-generations','POST',imageInput(c,undefined,1)),409,'avatar_batch_confirmation_required');
        await expectError(await call(c,'/avatar-generations','POST',imageInput(c,a.id,2)),409,'avatar_batch_confirmation_required');
        expect(c.settings().jobs).toEqual([]);expect(mock.calls).toHaveLength(0);
        const input=imageInput(c,undefined,2),response=await call(c,'/avatar-generations','POST',input);expect(response.status).toBe(202);
        const {jobs}=await response.json<{jobs:AvatarJob[]}>();expect(jobs.map(job=>job.botId)).toEqual([a.id,b.id]);
        await c.alarm();await c.alarm();expect(mock.calls).toHaveLength(2);
        expect(mock.calls[0]).toMatchObject({model:IMAGE_MODEL,n:1,size:'1024x1024',output_format:'png'});
        const stored=c.settings().avatars[0];expect(stored.mimeType).toBe('image/png');
        const png=await call(c,`/avatar/${a.id}`);expect(png.status).toBe(200);
        expect(png.headers.get('content-type')).toBe('image/png');expect(png.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
        expect(png.headers.get('content-disposition')).toBe(`attachment; filename="avatar-${stored.artifactId}.png"`);
        const bytes=new Uint8Array(await png.arrayBuffer());expect(btoa(String.fromCharCode(...bytes))).toBe(PNG);
        const etag=png.headers.get('etag')!;
        expect((await c.fetch(new Request(`https://workspace/avatar/${a.id}`,{headers:{'if-none-match':etag}}))).status).toBe(304);
        seed(state,'Added after accepted batch');
        expect((await (await call(c,'/avatar-generations','POST',input)).json<{jobs:AvatarJob[]}>()).jobs.map(job=>job.id)).toEqual(jobs.map(job=>job.id));
        await expectError(await call(c,'/avatar-generations','POST',{...input,confirmedCount:3}),409,'operation_conflict');
        expect(mock.calls).toHaveLength(2);for(const job of jobs)expectClearedSnapshot(state,job.id);
      });
    }finally{mock.restore();}
  });
  it('rechecks image batch count against bots created while catalog discovery yielded',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
        const provider=fakeProvider({catalogue:async()=>{enter();await gate;return Response.json({connected:false,models:[],defaultModel:MODEL});}});
        const c=imageCoordinator(state,provider);seed(state);await select(c,(await theme(c,'Confirmed batch','image',IMAGE_MODEL)).id);
        const admission=call(c,'/avatar-generations','POST',imageInput(c,undefined,1));await entered;seed(state,'Added during confirmation');release();
        await expectError(await admission,409,'avatar_batch_confirmation_required');expect(c.settings().jobs).toEqual([]);expect(mock.calls).toHaveLength(0);
      });
    }finally{mock.restore();}
  });
  it('retains the previous visible SVG across an invalid PNG generation without paid replay',async()=>{
    await runInDurableObject(stub(),async(_instance,state)=>{
      const provider=fakeProvider(),c=imageCoordinator(state,provider),bot=seed(state);await generate(c,bot.id);await c.alarm();
      const old=c.settings().avatars[0];await select(c,(await theme(c,'Raster desired','image',IMAGE_MODEL)).id);
      expect(c.settings().avatars[0]).toMatchObject({artifactId:old.artifactId,status:'obsolete'});
      expect((await call(c,`/avatar/${bot.id}`)).status).toBe(200);
      const mock=imageFetch('not-a-png');try{
        const input=imageInput(c,bot.id);expect((await call(c,'/avatar-generations','POST',input)).status).toBe(202);
        await c.alarm();await c.alarm();
        expect(c.settings().jobs[0]).toMatchObject({status:'failed',error:{code:'avatar_image_invalid'}});
        expect(c.settings().avatars[0]).toMatchObject({artifactId:old.artifactId,status:'obsolete'});
        expect(await (await call(c,`/avatar/${bot.id}`)).text()).toBe(sanitizeAvatarSvg(SVG));
        expect((await call(c,'/avatar-generations','POST',input)).status).toBe(202);await c.alarm();expect(mock.calls).toHaveLength(1);
        expectClearedSnapshot(state,c.settings().jobs[0].id);
      }finally{mock.restore();}
    });
  });
  it('recovers journaled PNG and publication failure without dispatching Image API again',async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        const provider=fakeProvider({connected:false}),bot=seed(state);let puts=0;
        const files=new Proxy(bindings.FILES,{get(target,property){
          if(property==='put')return async(...args:Parameters<R2Bucket['put']>)=>{puts++;if(puts===1)throw new Error('temporary storage failure');return target.put(...args);};
          const member=Reflect.get(target,property,target);return typeof member==='function'?member.bind(target):member;
        }});
        const c=imageCoordinator(state,provider,files);await select(c,(await theme(c,'Recover raster','image',IMAGE_MODEL)).id);
        const input=imageInput(c,bot.id);expect((await call(c,'/avatar-generations','POST',input)).status).toBe(202);await c.alarm();
        const job=c.settings().jobs[0];expect(job.status).toBe('running');expect(mock.calls).toHaveLength(1);
        expect(state.storage.sql.exec<{output:string}>('SELECT output FROM avatar_jobs WHERE id=?',job.id).one().output).toBe(PNG);
        state.storage.sql.exec('UPDATE avatar_jobs SET next_at=0 WHERE id=?',job.id);
        const recovered=imageCoordinator(state,provider,files);await recovered.alarm();
        expect(recovered.settings().jobs[0].status).toBe('completed');expect(mock.calls).toHaveLength(1);expect(puts).toBe(2);
        expectClearedSnapshot(state,job.id);expect((await call(recovered,`/avatar/${bot.id}`)).status).toBe(200);
        const pointer=recovered.settings().avatars[0];await bindings.FILES.put(`bots/${bot.id}/avatars/${pointer.artifactId}`,'bad raster',{httpMetadata:{contentType:'image/png'}});
        await expectError(await call(recovered,`/avatar/${bot.id}`),502,'avatar_image_invalid');
      });
    }finally{mock.restore();}
  });
  for(const change of ['replacement','delete'] as const)it(`fences delayed PNG arrayBuffer read after ${change}`,async()=>{
    const mock=imageFetch();try{
      await runInDurableObject(stub(),async(_instance,state)=>{
        const provider=fakeProvider({connected:false}),c=imageCoordinator(state,provider),bot=seed(state);await select(c,(await theme(c,'Image read race','image',IMAGE_MODEL)).id);
        expect((await call(c,'/avatar-generations','POST',imageInput(c,bot.id))).status).toBe(202);await c.alarm();expect(c.settings().jobs[0].status).toBe('completed');
        let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
        const files=new Proxy(bindings.FILES,{get(target,property){
          if(property==='get')return async(...args:Parameters<R2Bucket['get']>)=>{
            const object=await target.get(...args);return object?new Proxy(object,{get(value,key){
              if(key==='arrayBuffer')return async()=>{const bytes=await value.arrayBuffer();enter();await gate;return bytes;};
              const member=Reflect.get(value,key,value);return typeof member==='function'?member.bind(value):member;
            }}):null;
          };
          const member=Reflect.get(target,property,target);return typeof member==='function'?member.bind(target):member;
        }});
        const reader=imageCoordinator(state,provider,files),reading=call(reader,`/avatar/${bot.id}`);await entered;
        if(change==='replacement'){expect((await call(c,'/avatar-generations','POST',imageInput(c,bot.id))).status).toBe(202);await c.alarm();}
        else{state.storage.sql.exec('DELETE FROM bots WHERE id=?',bot.id);c.forgetBot(bot.id);await c.drainBot(bot.id);}
        release();await expectError(await reading,404,'avatar_not_ready');
      });
    }finally{mock.restore();}
  });
});
