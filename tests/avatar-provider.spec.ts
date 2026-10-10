import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Env} from '../apps/api/src/env';
import {MODEL_FAILURES} from '@botspace/contracts';
import {avatarModelCatalog, generateVectorAvatar, generateImageAvatar, imageGenerationError} from '../apps/api/src/avatar-provider';
const svg = '<svg viewBox="0 0 128 128"><path d="M5 5L20 5L10 20Z" fill="#abc"/></svg>';
const input = {model: 'account-text-model', prompt: 'flat forest theme', botName: 'Helper', botInstructions: 'Organizes tasks'};
const model = {id: input.model, name: 'Account text model', provider: 'openai', reasoningEfforts: ['high'], supportsFast: true, inputModalities: ['text', 'image']};
function mockEnv(handler: (request: Request) => Response | Promise<Response>, preflightHandler?: (request: Request) => Response | Promise<Response>) {
  const fetch = vi.fn((request: Request) => handler(request));
  const preflight = vi.fn((request: Request) => preflightHandler ? preflightHandler(request) : Response.json({settings: {model: input.model, fast: false}, model}));
  const dispatch = (request: Request) => new URL(request.url).pathname === '/validate-model' ? preflight(request) : fetch(request);
  const env = {CHATGPT: {idFromName: vi.fn(() => 'owner-id'), get: vi.fn(() => ({fetch: dispatch}))}} as unknown as Env;
  return {env, fetch, preflight};
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (text = svg) => ({type: 'response.completed', response: {status: 'completed', output: [{type: 'reasoning', summary: []}, {type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]}]}});
function stream(text: string, step = text.length): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({start(controller) {for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step)); controller.close();}}), {headers: {'content-type': 'text/event-stream'}});
}
describe('honest avatar provider transport', () => {
  it('uses only the owner account catalogue and never invents image IDs', async () => {
    const {env, fetch} = mockEnv(request => {expect(request.url).toBe('https://chatgpt/models'); return Response.json({connected: true, models: [model], defaultModel: input.model});});
    const catalog = await avatarModelCatalog(env);
    expect(catalog).toMatchObject({connected: true, vectorModels: [model], imageModels: [], imageAvailable: false});
    expect(imageGenerationError().message).toContain('OPENAI_API_KEY');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(imageGenerationError()).toMatchObject({status: 501, code: 'avatar_image_unavailable'});
  });
  it('labels documented Image API IDs as unavailable metadata, never selectable account options', async () => {
    const {env} = mockEnv(() => Response.json({connected: true, models: [model, {...model, id: 'gpt-image-2.5-sunburst'}, {...model, id: 'gpt-image-2.5-flare'}], defaultModel: input.model}));
    for (const catalog of [await avatarModelCatalog(env), await avatarModelCatalog({} as Env)]) {
      expect(catalog.unavailableImageModels).toEqual([
        {id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', available: false, reason: expect.stringContaining('SIWC')},
        {id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', available: false, reason: expect.stringContaining('SIWC')},
      ]);
      for (const unavailable of catalog.unavailableImageModels ?? []) {
        expect(unavailable.reason).toContain('does not support image generation');
        expect(catalog.vectorModels.some(option => option.id === unavailable.id)).toBe(false);
      }
      expect(catalog.imageModels).toEqual([]);
      expect(catalog.imageAvailable).toBe(false);
    }
  });
  it('returns no models when disconnected or the catalogue is unavailable, with bounded public diagnostics', async () => {
    expect(await avatarModelCatalog({} as Env)).toMatchObject({connected: false, vectorModels: [], imageModels: [], imageAvailable: false});
    const secret = 'private-provider-body';
    for (const response of [Response.json({connected: false, models: [model]}), Response.json({connected: true, models: [], error: secret}), Response.json({error: secret}, {status: 503}), Response.json({data: [{id: 'fake-image-model'}]})]) {
      const {env} = mockEnv(() => response);
      const catalog = await avatarModelCatalog(env);
      expect(catalog.vectorModels).toEqual([]);
      expect(JSON.stringify(catalog)).not.toContain(secret);
    }
    const {env} = mockEnv(() => {throw new Error(secret);});
    expect(JSON.stringify(await avatarModelCatalog(env))).not.toContain(secret);
  });
  it('validates the current connected text-capable model before one inference dispatch', async () => {
    const order: string[] = [];
    const {env, fetch, preflight} = mockEnv(() => {order.push('inference'); return stream(event(completed()));}, async request => {
      order.push('validate');
      expect(request.url).toBe('https://chatgpt/validate-model');
      expect(await request.json()).toEqual({model: input.model});
      return Response.json({settings: {model: input.model}, model});
    });
    await generateVectorAvatar(env, input);
    expect(order).toEqual(['validate', 'inference']);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unavailable/non-text/mismatched current models before inference with no retries', async () => {
    for (const response of [
      Response.json({error: {code: 'model_unavailable', message: 'private-provider-body'}}, {status: 400}),
      Response.json({settings: {model: input.model}, model: {...model, inputModalities: ['image']}}),
      Response.json({settings: {model: input.model}, model: {...model, inputModalities: []}}),
      Response.json({settings: {model: 'replacement'}, model: {...model, id: 'replacement'}}),
      Response.json({settings: {model: input.model}, model: {id: input.model}}),
    ]) {
      const {env, fetch, preflight} = mockEnv(() => stream(event(completed())), () => response);
      await expect(generateVectorAvatar(env, input)).rejects.not.toThrow('private-provider-body');
      expect(fetch).not.toHaveBeenCalled();
      expect(preflight).toHaveBeenCalledTimes(1);
    }
  });
  it('never dispatches known Image API IDs even when text input is advertised', async () => {
    for (const id of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
      const {env, fetch, preflight} = mockEnv(() => stream(event(completed())), () => Response.json({settings: {model: id}, model: {...model, id}}));
      await expect(generateVectorAvatar(env, {...input, model: id})).rejects.toMatchObject({code: 'avatar_model_unavailable'});
      expect(fetch).not.toHaveBeenCalled();
      expect(preflight).toHaveBeenCalledTimes(1);
    }
  });
  it('exposes only known fixed public model errors from bounded HTTP bodies', async () => {
    for (const code of ['chatgpt_not_connected', 'chatgpt_allowance_exhausted', 'model_access_denied'] as const) {
      for (const stage of ['preflight', 'inference']) {
        const errorResponse = () => Response.json({error: {code, message: 'private-provider-body'}}, {status: 403});
        const {env, fetch, preflight} = mockEnv(stage === 'inference' ? errorResponse : () => stream(event(completed())), stage === 'preflight' ? errorResponse : undefined);
        await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code, message: MODEL_FAILURES[code]});
        expect(fetch).toHaveBeenCalledTimes(stage === 'inference' ? 1 : 0);
        expect(preflight).toHaveBeenCalledTimes(1);
      }
    }
    for (const response of [
      Response.json({error: {code: 'unknown-secret-category', message: 'private-provider-body'}}, {status: 429}),
      new Response('private-provider-body', {status: 401}),
      Response.json({error: {code: 'chatgpt_allowance_exhausted', message: 'x'.repeat(20_000)}}, {status: 429}),
    ]) {
      const {env, fetch} = mockEnv(() => response);
      await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'avatar_generation_failed'});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps known SSE model categories but never provider messages', async () => {
    const {env, fetch} = mockEnv(() => stream(event({type: 'response.failed', response: {error: {code: 'chatgpt_allowance_exhausted', message: 'private-provider-body'}}})));
    await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'chatgpt_allowance_exhausted', message: MODEL_FAILURES.chatgpt_allowance_exhausted});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends a text-only request compatible with ChatGPTAuthDO validation, no image tools/billed fallback', async () => {
    const {env, fetch} = mockEnv(async request => {
      expect(request.url).toBe('https://chatgpt/responses');
      const body = await request.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream']);
      expect(body).toMatchObject({model: input.model, store: false, stream: true});
      expect(body.instructions).toContain('sin marco circular');
      expect(JSON.stringify(body.input)).toContain('input_text');
      expect(JSON.stringify(body)).not.toContain('image_generation');
      return stream(event({type: 'response.output_text.delta', delta: '<script>wrong</script>'}) + event(completed()) + 'data: [DONE]\n\n', 1);
    });
    expect(await generateVectorAvatar(env, input)).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts CRLF, comments and multiline SSE JSON only after a complete frame', async () => {
    const json = JSON.stringify(completed(), null, 2).split('\n').map(line => `data: ${line}`).join('\r\n');
    const {env} = mockEnv(() => stream(`: heartbeat\r\nevent: response.completed\r\n${json}\r\n\r\n`, 3));
    expect(await generateVectorAvatar(env, input)).toContain('<path');
  });
  const invalidStreams = [
    event({type: 'response.output_text.delta', delta: svg}),
    event({type: 'response.interrupted', message: 'private-provider-body'}),
    event({type: 'response.failed', response: {error: {message: 'private-provider-body'}}}),
    event({type: 'response.incomplete'}), event({type: 'error', message: 'private-provider-body'}),
    event({type: 'response.completed', response: {status: 'incomplete', output: []}}),
    event({type: 'response.completed', response: {status: 'completed', output: [{type: 'image_generation_call', result: 'fake-image'}]}}),
    event({type: 'response.completed', response: {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'refusal', refusal: 'no'}]}]}}),
    event({type: 'response.completed', response: {status: 'completed', output: []}}),
    event(completed('<svg><script>active</script></svg>')),
    event(completed()) + event({type: 'response.interrupted'}),
    event(completed()) + event(completed()),
    'data: {invalid-json}\n\n', event(completed()).trimEnd(),
  ];
  for (const [i, text] of invalidStreams.entries()) it(`fails closed without retry for incomplete/unsupported stream ${i + 1}`, async () => {
    const {env, fetch} = mockEnv(() => stream(text, 7));
    let error: unknown;
    try {await generateVectorAvatar(env, input);} catch (caught) {error = caught;}
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private-provider-body');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds output and total SSE bytes', async () => {
    for (const text of [event(completed(' '.repeat(33_000))), ': ' + 'x'.repeat(1_048_577) + '\n\n']) {
      const {env, fetch} = mockEnv(() => stream(text, 4096));
      await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'avatar_response_limit'});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('sanitizes HTTP/transport errors and never retries', async () => {
    for (const handler of [() => Response.json({error: {message: 'private-provider-body'}}, {status: 400}), () => {throw new Error('private-provider-body');}, () => new Response('private-provider-body')]) {
      const {env, fetch} = mockEnv(handler);
      await expect(generateVectorAvatar(env, input)).rejects.not.toThrow('private-provider-body');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('cancels unsupported non-SSE bodies instead of leaving a provider stream open', async () => {
    const cancelled = vi.fn();
    const {env, fetch} = mockEnv(() => new Response(new ReadableStream<Uint8Array>({cancel: cancelled}), {headers: {'content-type': 'application/json'}}));
    await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'avatar_response_invalid'});
    expect(cancelled).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid input before dispatch and pre-aborted generation without retries', async () => {
    const {env, fetch} = mockEnv(() => stream(event(completed())));
    for (const bad of [{...input, model: '@cf/billed'}, {...input, model: 'bad model'}, {...input, prompt: ''}, {...input, prompt: 'x'.repeat(8001)}, {...input, botInstructions: 'x'.repeat(32001)}]) await expect(generateVectorAvatar(env, bad)).rejects.toMatchObject({code: 'avatar_input_invalid'});
    const controller = new AbortController(); controller.abort();
    await expect(generateVectorAvatar(env, input, controller.signal)).rejects.toMatchObject({code: 'avatar_generation_interrupted'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels an in-flight stream when its signal aborts', async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    const {env, fetch} = mockEnv(() => new Response(new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new TextEncoder().encode(': waiting\n\n')); queueMicrotask(() => controller.abort());}, cancel: cancelled}), {headers: {'content-type': 'text/event-stream'}}));
    await expect(generateVectorAvatar(env, input, controller.signal)).rejects.toMatchObject({code: 'avatar_generation_interrupted'});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalled();
  });
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const imageInput = {...input, model: 'gpt-image-2.5-sunburst'};
const imageEnv = {OPENAI_API_KEY: 'test-key-not-a-real-secret'} as Env;
afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});
describe('explicit server-only OpenAI Image API', () => {
  it('makes image configuration independent of SIWC and never infers verified entitlement or price', async () => {
    const fetch = vi.fn(() => {throw new Error('should not dispatch API');}); vi.stubGlobal('fetch', fetch);
    for (const env of [imageEnv, {...mockEnv(() => Response.json({error: 'private-body'}, {status: 503})).env, ...imageEnv}]) {
      const catalog = await avatarModelCatalog(env);
      expect(catalog).toMatchObject({connected: false, vectorModels: [], imageAvailable: true, imageBilling: {provider: 'openai-api', separateFromChatGPT: true, costKnown: false}});
      expect(catalog.imageModels.map(model => model.id)).toEqual(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
      expect(catalog.imageModels.every(model => model.billing === 'openai-api')).toBe(true);
      expect(JSON.stringify(catalog)).not.toContain(imageEnv.OPENAI_API_KEY);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enables images only with a valid server secret, not SIWC model claims', async () => {
    for (const key of [undefined, '', ' key', 'key\n', 'x'.repeat(4097)]) {
      expect(await avatarModelCatalog({OPENAI_API_KEY: key} as Env)).toMatchObject({imageAvailable: false, imageModels: []});
    }
    const {env} = mockEnv(() => Response.json({connected: true, models: [model], defaultModel: input.model}));
    expect(await avatarModelCatalog({...env, ...imageEnv})).toMatchObject({connected: true, vectorModels: [model], imageAvailable: true});
  });
  it('POSTs one PNG image to the fixed endpoint for both reviewed IDs, no Responses fallback or URL follow', async () => {
    for (const id of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
      const fetch = vi.fn(async (url: string, options: RequestInit) => {
        expect(url).toBe('https://api.openai.com/v1/images/generations');
        expect(options).toMatchObject({method: 'POST', redirect: 'error'});
        expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${imageEnv.OPENAI_API_KEY}`);
        const body = JSON.parse(options.body as string);
        expect(body).toMatchObject({model: id, n: 1, size: '1024x1024', quality: 'low', output_format: 'png'});
        expect(Object.keys(body).sort()).toEqual(['model', 'n', 'output_format', 'prompt', 'quality', 'size']);
        expect(body.prompt).toContain(input.botName);
        expect(body.prompt).not.toContain(imageEnv.OPENAI_API_KEY);
        return Response.json({data: [{b64_json: png}], usage: {total_tokens: 1}});
      }); vi.stubGlobal('fetch', fetch);
      expect(await generateImageAvatar(imageEnv, {...imageInput, model: id})).toBe(png);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('never switches billing transport after failure, even when both connections are configured', async () => {
    const {env, fetch: chatgpt, preflight} = mockEnv(() => stream(event(completed())));
    const api = vi.fn(() => Response.json({error: {message: 'private-provider-body'}}, {status: 500})); vi.stubGlobal('fetch', api);
    await expect(generateImageAvatar({...env, ...imageEnv}, imageInput)).rejects.toMatchObject({code: 'avatar_image_generation_failed'});
    expect(api).toHaveBeenCalledTimes(1); expect(chatgpt).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
    api.mockClear();
    expect(await generateVectorAvatar({...env, ...imageEnv}, input)).toContain('<path');
    expect(api).not.toHaveBeenCalled(); expect(chatgpt).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported model/input, missing secret and pre-cancellation before any paid dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const bad of [{...imageInput, model: 'gpt-image-1'}, {...imageInput, prompt: ''}, {...imageInput, botName: ''}, {...imageInput, prompt: 'x'.repeat(8001)}, {...imageInput, botInstructions: 'x'.repeat(32001)}]) {
      await expect(generateImageAvatar(imageEnv, bad)).rejects.toMatchObject({code: 'avatar_input_invalid'});
    }
    await expect(generateImageAvatar({} as Env, imageInput)).rejects.toMatchObject({code: 'avatar_image_unavailable'});
    const controller = new AbortController(); controller.abort();
    await expect(generateImageAvatar(imageEnv, imageInput, controller.signal)).rejects.toMatchObject({code: 'avatar_generation_interrupted'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects URLs, multi-image/invalid PNG/oversized base64, never fetching returned resources', async () => {
    for (const raw of [
      {data: [{url: 'https://example.test/secret.png'}]}, {data: [{b64_json: png, url: 'https://example.test/secret.png'}]},
      {data: [{b64_json: png}, {b64_json: png}]}, {data: []}, {data: [{b64_json: 'data:image/png;base64,' + png}]},
      {data: [{b64_json: btoa('<svg><script>secret</script></svg>')}]}, {data: [{b64_json: 'A'.repeat(7_000_000)}]},
    ]) {
      const fetch = vi.fn(() => Response.json(raw)); vi.stubGlobal('fetch', fetch);
      await expect(generateImageAvatar(imageEnv, imageInput)).rejects.toBeInstanceOf(Error);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('does not forward error bodies, keys or transport diagnostics and never retries billed calls', async () => {
    for (const [status, code] of [[401, 'avatar_image_access_denied'], [403, 'avatar_image_access_denied'], [429, 'avatar_image_rate_limited'], [500, 'avatar_image_generation_failed']] as const) {
      const fetch = vi.fn(() => Response.json({error: {message: 'private-error ' + imageEnv.OPENAI_API_KEY}}, {status})); vi.stubGlobal('fetch', fetch);
      await expect(generateImageAvatar(imageEnv, imageInput)).rejects.toMatchObject({code});
      try {await generateImageAvatar(imageEnv, imageInput);} catch (e) {expect(String(e)).not.toContain('private-error'); expect(String(e)).not.toContain(imageEnv.OPENAI_API_KEY);}
      // Each explicit invocation dispatches exactly once; no internal retry.
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    const fetch = vi.fn(() => {throw new Error('private-error ' + imageEnv.OPENAI_API_KEY);}); vi.stubGlobal('fetch', fetch);
    await expect(generateImageAvatar(imageEnv, imageInput)).rejects.toMatchObject({code: 'avatar_image_generation_failed'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds both HTTP and response-body transport at 30 minutes and clears timers after success', async () => {
    vi.useFakeTimers();
    const inputSignal = new AbortController();
    const http = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('private-abort-body')), {once: true});
    })); vi.stubGlobal('fetch', http);
    const pending = generateImageAvatar(imageEnv, imageInput, inputSignal.signal);
    const rejected = expect(pending).rejects.toMatchObject({code: 'avatar_generation_interrupted', message: expect.stringContaining('30-minute')});
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); await rejected;
    expect(http).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    const cancel = vi.fn();
    const body = vi.fn(() => new Response(new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new TextEncoder().encode('{'));}, cancel}), {headers: {'content-type': 'application/json'}})); vi.stubGlobal('fetch', body);
    const streaming = generateImageAvatar(imageEnv, imageInput);
    const streamRejected = expect(streaming).rejects.toMatchObject({code: 'avatar_generation_interrupted', message: expect.stringContaining('30-minute')});
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); await streamRejected;
    expect(cancel).toHaveBeenCalledTimes(1); expect(body).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal('fetch', vi.fn(() => Response.json({data: [{b64_json: png}]})));
    expect(await generateImageAvatar(imageEnv, imageInput)).toBe(png); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds streaming bodies and cancels unsupported or aborted streams', async () => {
    const cancelled = vi.fn();
    let fetch = vi.fn(() => new Response(new ReadableStream<Uint8Array>({cancel: cancelled}), {headers: {'content-type': 'text/html'}})); vi.stubGlobal('fetch', fetch);
    await expect(generateImageAvatar(imageEnv, imageInput)).rejects.toMatchObject({code: 'avatar_image_invalid'});
    expect(cancelled).toHaveBeenCalled();
    fetch = vi.fn(() => new Response(' '.repeat(7_100_000), {headers: {'content-type': 'application/json'}})); vi.stubGlobal('fetch', fetch);
    await expect(generateImageAvatar(imageEnv, imageInput)).rejects.toMatchObject({code: 'avatar_response_limit'});
    const controller = new AbortController();
    fetch = vi.fn(() => new Response(new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new TextEncoder().encode('{')); queueMicrotask(() => controller.abort());}, cancel: cancelled}), {headers: {'content-type': 'application/json'}})); vi.stubGlobal('fetch', fetch);
    await expect(generateImageAvatar(imageEnv, imageInput, controller.signal)).rejects.toMatchObject({code: 'avatar_generation_interrupted'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
