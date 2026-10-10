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
  it('forwards explicit theme reasoning to validation and inference; defaults stay unset',async()=>{
    for(const reasoningEffort of ['high',undefined]){
      const {env,fetch}=mockEnv(async request=>{
        expect((await request.json<{reasoning?:unknown}>()).reasoning).toEqual(reasoningEffort?{effort:reasoningEffort}:undefined);
        return stream(event(completed()));
      },async request=>{
        expect(await request.json()).toEqual({model:input.model,...(reasoningEffort?{reasoningEffort}:{})});
        return Response.json({settings:{model:input.model,reasoningEffort:'high'},model});
      });
      await generateVectorAvatar(env,{...input,reasoningEffort});expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('never silently downgrades an unsupported or mismatched reasoning preference',async()=>{
    for(const reasoningEffort of ['low','high']){
      const {env,fetch}=mockEnv(()=>stream(event(completed())),()=>Response.json({settings:{model:input.model,reasoningEffort:'medium'},model}));
      await expect(generateVectorAvatar(env,{...input,reasoningEffort})).rejects.toMatchObject({code:'avatar_reasoning_unavailable'});
      expect(fetch).not.toHaveBeenCalled();
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
  // Synthetic Responses wire fixture, not a captured production/provider log.
  // Mirrors runtime/test/responses-fixture.ts and the SDK's complete item shape.
  const streamedMessage = {id: 'msg_avatar', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: svg, annotations: []}]};
  function itemStream(items: Record<string, unknown>[] = [streamedMessage]): Record<string, unknown>[] {
    return [
      {type: 'response.created', response: {id: 'resp_avatar', status: 'in_progress', output: []}},
      ...items.flatMap((item, output_index) => [
        {type: 'response.output_item.added', output_index, item: {...item, status: 'in_progress', ...(item.type === 'message' ? {content: []} : {})}},
        ...(item.type === 'message' ? [{type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: svg}] : []),
        {type: 'response.output_item.done', output_index, item},
      ]),
      {type: 'response.completed', response: {id: 'resp_avatar', status: 'completed', output: []}},
    ];
  }
  const wire = (events: Record<string, unknown>[]) => events.map(event).join('');
  it('accepts complete identified streamed items when the completed summary has empty output, without retry', async () => {
    const items = [{id: 'rs_avatar', type: 'reasoning', summary: []}, streamedMessage];
    for (const step of [1, 7, 4096]) {
      const {env, fetch, preflight} = mockEnv(() => stream(wire(itemStream(items)) + 'data: [DONE]\n\n', step));
      expect(await generateVectorAvatar(env, input)).toContain('<path');
      expect(fetch).toHaveBeenCalledTimes(1); expect(preflight).toHaveBeenCalledTimes(1);
    }
  });
  it('accepts minimal created/added/done/completed proof without any text deltas', async () => {
    const events = itemStream().filter(item => item.type !== 'response.output_text.delta');
    const {env, fetch} = mockEnv(() => stream(wire(events), 1));
    expect(await generateVectorAvatar(env, input)).toContain('<path');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts the realistic Pi fixture lifecycle with a full authoritative final snapshot', async () => {
    const items = [{id: 'rs_avatar', type: 'reasoning', summary: [], encrypted_content: 'synthetic-fixture-ciphertext'}, streamedMessage];
    const events = itemStream(items);
    events[events.length - 1] = {type: 'response.completed', response: {id: 'resp_avatar', object: 'response', status: 'completed', output: items, usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}}};
    const namedFrames = events.map((value, sequence_number) => `event: ${value.type}\ndata: ${JSON.stringify({...value, sequence_number})}\n\n`).join('');
    const {env, fetch} = mockEnv(() => stream(namedFrames, 7));
    expect(await generateVectorAvatar(env, input)).toContain('<path');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('orders complete items by output_index, without concatenating repeated deltas or snapshots', async () => {
    const parts = [svg.slice(0, 25), svg.slice(25)];
    const items = parts.map((text, i) => ({...streamedMessage, id: `msg_${i}`, content: [{type: 'output_text', text}]}));
    const original = itemStream(items);
    // Both items are introduced first; completion arrival order is independent.
    const events = [0, 1, 4, 2, 5, 6, 3, 7].map(index => original[index]);
    const {env} = mockEnv(() => stream(wire(events), 3));
    expect(await generateVectorAvatar(env, input)).toContain('<path');
  });
  it('keeps a nonempty completed snapshot authoritative and never patches invalid terminal output', async () => {
    const events = itemStream();
    events[events.length - 1] = completed();
    const {env} = mockEnv(() => stream(wire(events)));
    expect(await generateVectorAvatar(env, input)).toContain('<path');
    for (const output of [
      [{...streamedMessage, status: 'incomplete'}],
      [{...streamedMessage, content: [{type: 'refusal', refusal: 'private-provider-body'}]}],
      [{type: 'function_call', name: 'image_generation', arguments: '{}'}],
      [{...streamedMessage, content: [{type: 'output_text', text: ''}]}],
    ]) {
      const invalid = [...itemStream().slice(0, -1), {type: 'response.completed', response: {id: 'resp_avatar', status: 'completed', output}}];
      const {env, fetch} = mockEnv(() => stream(wire(invalid)));
      await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'avatar_response_invalid'});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('fails closed for incomplete, conflicting or unsupported streamed completion proofs', async () => {
    const base = itemStream();
    const copy = () => structuredClone(base);
    const cases: Record<string, unknown>[][] = [
      base.slice(1), // no response identity
      base.filter(item => item.type !== 'response.output_item.added'),
      [base[0], base[3], base[1], base[2], base[4]], // done-before-added is deliberately not a completion proof
      base.filter(item => item.type !== 'response.output_item.done'), // deltas alone
      base.slice(0, -1), // complete item is not a terminal response
      itemStream([{...streamedMessage, status: 'in_progress'}]),
      itemStream([{...streamedMessage, status: undefined}]),
      itemStream([{...streamedMessage, id: ''}]),
      itemStream([{...streamedMessage, id: 'x'.repeat(257)}]),
      itemStream([streamedMessage, streamedMessage]), // duplicate ID across indexes
      itemStream([{...streamedMessage, role: 'user'}]),
      itemStream([{...streamedMessage, content: [{type: 'refusal', refusal: 'private-provider-body'}]}]),
      itemStream([{id: 'fc_avatar', type: 'function_call', status: 'completed', name: 'exec', arguments: '{}'}, streamedMessage]),
      itemStream([{id: 'rs_avatar', type: 'reasoning', status: 'incomplete'}, streamedMessage]),
      itemStream([{...streamedMessage, content: [{type: 'output_text', text: ''}]}]),
      [...base.slice(0, -1), {type: 'response.refusal.delta', delta: 'private-provider-body'}, base.at(-1)!],
      [...base.slice(0, -1), base[0], base.at(-1)!], // duplicate created
      [...base.slice(0, -1), base[3], base.at(-1)!], // duplicate done
      [...base.slice(0, -1), {type: 'response.output_item.added', output_index: 1, item: {...streamedMessage, id: 'unfinished', status: 'in_progress'}}, base.at(-1)!],
      [...base, base[2]], // output after terminal
      [...base.slice(0, -1), {type: 'response.incomplete'}],
      [...base, {type: 'response.failed', response: {error: {message: 'private-provider-body'}}}],
    ];
    for (const change of [
      (events: Record<string, unknown>[]) => {events[3].item = {...streamedMessage, id: 'different'};},
      (events: Record<string, unknown>[]) => {events[3].item = {...streamedMessage, type: 'reasoning'};},
      (events: Record<string, unknown>[]) => {events[4].response = {id: 'different', status: 'completed', output: []};},
      (events: Record<string, unknown>[]) => {events[1].output_index = 1; events[3].output_index = 1;},
      (events: Record<string, unknown>[]) => {events[1].output_index = -1;},
      (events: Record<string, unknown>[]) => {events[3].output_index = 0.5;},
      (events: Record<string, unknown>[]) => {events[1].output_index = 256;},
      (events: Record<string, unknown>[]) => {events[4].response = {id: 'resp_avatar', status: 'incomplete', output: []};},
    ]) {const events = copy(); change(events); cases.push(events);}
    for (const events of cases) {
      const {env, fetch} = mockEnv(() => stream(wire(events), 7));
      await expect(generateVectorAvatar(env, input)).rejects.not.toThrow('private-provider-body');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('preserves genuinely empty completed responses and bounds/sanitizes streamed snapshots', async () => {
    const noText = [itemStream([]), itemStream([{id: 'rs_avatar', type: 'reasoning', summary: []}])];
    for (const events of noText) {
      const {env} = mockEnv(() => stream(wire(events)));
      await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code: 'avatar_response_invalid', message: 'The avatar response did not contain completed text.'});
    }
    for (const [text, code] of [['x'.repeat(33_000), 'avatar_response_limit'], ['<svg><script>active</script></svg>', 'avatar_svg_invalid']]) {
      const {env, fetch} = mockEnv(() => stream(wire(itemStream([{...streamedMessage, content: [{type: 'output_text', text}]}]))));
      await expect(generateVectorAvatar(env, input)).rejects.toMatchObject({code});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
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
  it('requests transparent PNG artwork for head themes, leaving the solid circle to the UI',async()=>{
    const fetch=vi.fn(async(_url:string,options:RequestInit)=>{
      expect(JSON.parse(options.body as string)).toMatchObject({background:'transparent',output_format:'png',n:1});
      return Response.json({data:[{b64_json:png}]});
    });vi.stubGlobal('fetch',fetch);
    expect(await generateImageAvatar(imageEnv,{...imageInput,transparentBackground:true})).toBe(png);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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
        // Use workerd's real Request validation, not just a permissive fetch
        // mock: redirect:"error" previously passed tests but failed in prod.
        const request = new Request(url, options);
        expect(request.redirect).toBe('manual');
        expect(url).toBe('https://api.openai.com/v1/images/generations');
        expect(options).toMatchObject({method: 'POST', redirect: 'manual'});
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
  it('rejects redirects without following a destination or repeating the image request',async()=>{
    for(const status of [301,302,303,307,308]){
      const fetch=vi.fn(async(url:string,options:RequestInit)=>{
        const request=new Request(url,options);expect(request.redirect).toBe('manual');
        expect(request.url).toBe('https://api.openai.com/v1/images/generations');
        return new Response(null,{status,headers:{location:'https://untrusted.test/image'}});
      });vi.stubGlobal('fetch',fetch);
      await expect(generateImageAvatar(imageEnv,imageInput)).rejects.toMatchObject({code:'avatar_image_generation_failed'});
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
