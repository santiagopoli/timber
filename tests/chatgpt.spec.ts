import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPES = "openid email offline_access resource.invoke chatgpt.tokens.use.direct";
const CLIENT_ID = "timber-test-client";
const API_TOKEN = "test-only-botspace-owner-token-000000";
const bindings = env as unknown as {CHATGPT: DurableObjectNamespace; KEYLESS_CHATGPT: DurableObjectNamespace};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let refreshedTokens: Record<string, unknown>;
let refreshCalls: string[];
let responseCalls: {authorization: string; payload: Record<string, unknown>; signal?: AbortSignal}[];
let revocations: URLSearchParams[];
let inference: () => Response;
let refreshError: string | undefined;
let revocationFails: boolean;
let modelCalls: string[];
let catalogResponse:()=>Response|Promise<Response>;
const defaultModels={models:[
  {slug:"gpt-6.1-sol",display_name:"GPT-6.1 Sol",visibility:"list",supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"},{effort:"max"}],default_reasoning_level:"medium",service_tiers:[{id:"fast"}],input_modalities:["text","image"]},
  {slug:"gpt-6-luna",display_name:"GPT-6 Luna",visibility:"list",supported_reasoning_levels:[],service_tiers:[]},
]};

function completedStream() {
  return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', {headers: {"content-type": "text/event-stream"}});
}
async function sign(claims: JWTPayload, audience: string, options: {issuer?: string; expiresAt?: number} = {}) {
  return new SignJWT(claims).setProtectedHeader({alg: "ES256", kid: "test-key"})
    .setIssuer(options.issuer ?? ISSUER).setAudience(audience).setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600).sign(keys.privateKey);
}
async function credentials(hostId: string, change: {identity?: JWTPayload; access?: JWTPayload; idAudience?: string; accessAudience?: string; issuer?: string; expiresAt?: number; nonce?: string; scope?: string} = {}) {
  const identity = {sub: "test-user", email: "test@example.invalid", nonce: "test-nonce", ...change.identity};
  const access = {sub: "test-user", client_id: CLIENT_ID, scope: PLAN_SCOPES, ...change.access};
  return {
    client_id: CLIENT_ID,
    access_token: await sign(access, change.accessAudience ?? RESOURCE, {issuer: change.issuer, expiresAt: change.expiresAt}),
    refresh_token: "test-refresh-token-original",
    id_token: await sign(identity, change.idAudience ?? CLIENT_ID),
    scope: change.scope ?? PLAN_SCOPES,
    nonce: change.nonce ?? "test-nonce",
    ext_agent_host_id: hostId,
  };
}
function newStub(keyless = false) {
  const namespace = keyless ? bindings.KEYLESS_CHATGPT : bindings.CHATGPT;
  return namespace.get(namespace.idFromName(crypto.randomUUID()));
}
async function status(stub: DurableObjectStub) {return (await stub.fetch("https://chatgpt/")).json<Record<string, unknown>>();}
async function connect(stub: DurableObjectStub, value?: Awaited<ReturnType<typeof credentials>>) {
  const payload = value ?? await credentials(String((await status(stub)).hostId));
  const response = await stub.fetch("https://chatgpt/", {method: "POST", body: JSON.stringify(payload)});
  // Drain the DO response before an eviction test so no abandoned body pins it.
  return new Response(await response.text(), {status: response.status, headers: response.headers});
}
async function infer(stub: DurableObjectStub, extra: Record<string, unknown> = {}) {
  return stub.fetch("https://chatgpt/responses", {method: "POST", body: JSON.stringify({model: "gpt-6.1-sol", input: [{role: "user", content: "test"}], store: false, stream: true, ...extra})});
}
async function stored(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_instance, state) => Object.fromEntries(await state.storage.list()));
}

beforeAll(async () => {
  keys = await generateKeyPair("ES256");
  jwk = {...await exportJWK(keys.publicKey), kid: "test-key", alg: "ES256", use: "sig"};
});
beforeEach(() => {
  refreshCalls = []; responseCalls = []; revocations = []; refreshedTokens = {};modelCalls=[];catalogResponse=()=>Response.json(defaultModels);
  refreshError = undefined; revocationFails = false; inference = completedStream;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({issuer: ISSUER, jwks_uri: `${ISSUER}/test-jwks`, revocation_endpoint: `${ISSUER}/test-revoke`});
    if (url === `${ISSUER}/test-jwks`) return Response.json({keys: [jwk]});
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("resource")).toBe(RESOURCE);
      refreshCalls.push(params.get("refresh_token")!);
      return refreshError ? Response.json({error: refreshError}, {status: 400}) : Response.json(refreshedTokens);
    }
    if(url===`${RESOURCE}/models`) {modelCalls.push(new Headers(init?.headers).get("authorization")??"");return catalogResponse();}
    if (url === `${RESOURCE}/responses`) {
      responseCalls.push({authorization: new Headers(init?.headers).get("authorization") ?? "", payload: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined});
      return inference();
    }
    if (url === `${ISSUER}/test-revoke`) {
      revocations.push(new URLSearchParams(String(init?.body)));
      return new Response(null, {status: revocationFails ? 503 : 200});
    }
    throw new Error(`Unexpected network access in offline auth test: ${url}`);
  });
});
afterEach(() => {vi.restoreAllMocks();});

describe("ChatGPT public connection boundary", () => {
  it("requires owner authentication for every connection action", async () => {
    for (const [path, method] of [["", "GET"], ["", "POST"], ["", "DELETE"], ["/verify", "POST"]]) {
      const response = await exports.default.fetch(`https://timber.test/v1/connections/chatgpt${path}`, {method});
      expect(response.status).toBe(401);
      await response.text();
    }
  });

  it("does not expose the internal inference proxy as a public endpoint", async () => {
    const response = await exports.default.fetch("https://timber.test/v1/connections/chatgpt/responses", {
      method: "POST", headers: {authorization: `Bearer ${API_TOKEN}`}, body: "{}",
    });
    expect(response.status).toBe(404);
    expect(responseCalls).toHaveLength(0);
  });

  it("returns only connection metadata to an authenticated owner", async () => {
    const response = await exports.default.fetch("https://timber.test/v1/connections/chatgpt", {headers: {authorization: `Bearer ${API_TOKEN}`}});
    expect(response.status).toBe(200);
    const result = await response.json<Record<string, unknown>>();
    expect(result).toMatchObject({connected: false, status: "disconnected", hostId: expect.stringMatching(/^urn:uuid:/)});
    expect(result).not.toHaveProperty("credentials");
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
  });
});

describe("ChatGPT signed identity and credential storage", () => {
  it("accepts signed tokens and stores only encrypted credential material", async () => {
    const stub = newStub();
    const payload = await credentials(String((await status(stub)).hostId));
    const response = await connect(stub, payload);
    expect(response.status).toBe(200);
    const result = await response.json<Record<string, unknown>>();
    expect(result).toMatchObject({connected: true, status: "connected_unverified", account: {clientId: CLIENT_ID, subject: "test-user"}});
    const clearStatus = JSON.stringify(result);
    const atRest = await stored(stub);
    for (const token of [payload.access_token, payload.refresh_token, payload.id_token]) {
      expect(clearStatus).not.toContain(token);
      expect(JSON.stringify(atRest)).not.toContain(token);
    }
    expect(atRest.credentials).toEqual({iv: expect.any(String), ciphertext: expect.any(String)});
  });

  it.each([
    ["nonce", {nonce: "wrong-nonce"}],
    ["subject", {access: {sub: "another-user"}}],
    ["client", {access: {client_id: "another-client"}}],
    ["ID audience", {idAudience: "another-client"}],
    ["access audience", {accessAudience: "https://another.invalid"}],
    ["issuer", {issuer: "https://another.invalid"}],
    ["signed scopes", {access: {scope: "openid resource.invoke"}}],
    ["declared scopes", {scope: "openid resource.invoke"}],
  ] as const)("rejects a mismatched %s without storing credentials", async (_name, change) => {
    const stub = newStub();
    const response = await connect(stub, await credentials(String((await status(stub)).hostId), change));
    expect(response.status).toBe(400);
    expect((await status(stub)).connected).toBe(false);
    expect((await stored(stub)).credentials).toBeUndefined();
  });

  it("rejects invalid signatures and expired access tokens", async () => {
    for (const invalid of ["signature", "expired"]) {
      const stub = newStub();
      const payload = await credentials(String((await status(stub)).hostId), invalid === "expired" ? {expiresAt: Math.floor(Date.now() / 1000) - 60} : {});
      if (invalid === "signature") {
        const parts = payload.access_token.split(".");
        parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
        payload.access_token = parts.join(".");
      }
      expect((await connect(stub, payload)).status).toBe(400);
      expect((await stored(stub)).credentials).toBeUndefined();
    }
  });

  it("fails closed if the host encryption key is absent", async () => {
    const stub = newStub(true);
    const response = await connect(stub);
    expect(response.status).toBe(503);
    expect((await stored(stub)).credentials).toBeUndefined();
  });

  it("rejects an otherwise valid sign-in prepared for another host", async () => {
    const stub = newStub();
    const response = await connect(stub, await credentials("urn:uuid:another-host"));
    expect(response.status).toBe(409);
    expect((await stored(stub)).credentials).toBeUndefined();
  });
});

describe("ChatGPT refresh ownership, billing route and verification", () => {
  it("rotates a near-expiry refresh token once for concurrent requests and persists the replacement", async () => {
    const stub = newStub();
    const payload = await credentials(String((await status(stub)).hostId), {expiresAt: Math.floor(Date.now() / 1000) + 30});
    expect((await connect(stub, payload)).status).toBe(200);
    const replacement = await credentials(payload.ext_agent_host_id);
    refreshedTokens = {...replacement, refresh_token: "test-refresh-token-rotated"};
    const [first, second] = await Promise.all([infer(stub), infer(stub)]);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    await Promise.all([first.text(), second.text()]);
    expect(refreshCalls).toEqual([payload.refresh_token]);
    expect(responseCalls.map(call => call.authorization)).toEqual([`Bearer ${replacement.access_token}`, `Bearer ${replacement.access_token}`]);
    // Simulate a process crash, rather than waiting for the stream timeout's
    // timer during graceful eviction. Persisted credentials must survive it.
    await abortAllDurableObjects();
    const recovered = bindings.CHATGPT.get(stub.id);
    const third = await infer(recovered);
    expect(third.status).toBe(200); await third.text();
    expect(refreshCalls).toHaveLength(1);
    const disconnected = await recovered.fetch("https://chatgpt/", {method: "DELETE"});
    expect(disconnected.status).toBe(200); await disconnected.text();
    expect(revocations[0].get("token")).toBe("test-refresh-token-rotated");
  });

  it("does not invoke inference or another billing provider without a connection", async () => {
    const response = await infer(newStub());
    expect(response.status).toBe(409);
    expect(responseCalls).toHaveLength(0);
    expect(refreshCalls).toHaveLength(0);
  });

  it("rejects unsupported billing-route parameters before contacting inference", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    for (const input of [{model: "other-model"}, {store: true}, {stream: false}, {temperature: 1}, {previous_response_id: "response-id"}]) {
      const response = await infer(stub, input);
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(responseCalls).toHaveLength(0);
  });

  it("sanitizes provider failures and never retries through an API-key route", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    inference = () => Response.json({error: {code: "subscription_sharing_route_not_supported", message: "private-token-and-provider-details"}}, {status: 403});
    const response = await infer(stub);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain("subscription_sharing_route_not_supported");
    expect(text).not.toContain("private-token-and-provider-details");
    expect(responseCalls).toHaveLength(1);
  });

  it.each([
    ["truncated", 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'],
    ["failed", 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n'],
    ["incomplete", 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'],
  ])("does not mark a %s verification stream as verified", async (_name, stream) => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    inference = () => new Response(stream);
    const response = await stub.fetch("https://chatgpt/verify", {method: "POST"});
    expect(response.status).toBe(502); await response.text();
    expect((await status(stub)).status).toBe("connected_unverified");
  });

  it("marks a completed terminal response as verified", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    const response = await stub.fetch("https://chatgpt/verify", {method: "POST"});
    expect(response.status).toBe(200); await response.text();
    expect(await status(stub)).toMatchObject({status: "verified", verifiedAt: expect.any(String)});
  });

  it("clears credentials and attempts refresh-token revocation on disconnect", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    const response = await stub.fetch("https://chatgpt/", {method: "DELETE"});
    expect(await response.json()).toMatchObject({connected: false, status: "disconnected", revoked: true});
    expect((await stored(stub)).credentials).toBeUndefined();
    expect(revocations[0].get("token_type_hint")).toBe("refresh_token");
    expect((await infer(stub)).status).toBe(409);
  });

  it("still removes local credentials when provider revocation cannot be confirmed", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    revocationFails = true;
    const response = await stub.fetch("https://chatgpt/", {method: "DELETE"});
    expect(await response.json()).toMatchObject({connected: false, revoked: false});
    expect((await stored(stub)).credentials).toBeUndefined();
  });

  it("requires a new sign-in after refresh revocation and does not contact inference", async () => {
    const stub = newStub();
    const payload = await credentials(String((await status(stub)).hostId), {expiresAt: Math.floor(Date.now() / 1000) + 30});
    expect((await connect(stub, payload)).status).toBe(200);
    refreshError = "invalid_grant";
    const response = await infer(stub);
    expect(response.status).toBe(401); await response.text();
    expect(await status(stub)).toMatchObject({connected: false, status: "reauthorization_required"});
    expect((await stored(stub)).credentials).toBeUndefined();
    expect(responseCalls).toHaveLength(0);
  });

  it("permits a different account only after disconnecting the previous account", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    const replacement = await credentials(String((await status(stub)).hostId), {identity: {sub: "other-user"}, access: {sub: "other-user"}});
    expect((await connect(stub, replacement)).status).toBe(409);
    const disconnected = await stub.fetch("https://chatgpt/", {method: "DELETE"});
    expect(disconnected.status).toBe(200); await disconnected.text();
    expect((await connect(stub, replacement)).status).toBe(200);
    expect(await status(stub)).toMatchObject({connected: true, account: {subject: "other-user"}});
  });

  it("aborts an active inference request when the account disconnects", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    inference = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));},
    }));
    const response = await infer(stub);
    const reader = response.body!.getReader();
    try {
      expect((await reader.read()).done).toBe(false);
      const disconnected = await stub.fetch("https://chatgpt/", {method: "DELETE"});
      expect(disconnected.status).toBe(200); await disconnected.text();
      expect(responseCalls[0].signal?.aborted).toBe(true);
      expect((await stored(stub)).credentials).toBeUndefined();
    } finally {await reader.cancel();}
  });

  it("cannot verify a newly connected session using a response from before disconnect", async () => {
    const stub = newStub();
    expect((await connect(stub)).status).toBe(200);
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    // Deliberately ignore the transport's abort signal: the durable revision
    // check must still prevent a delayed result from authorizing another login.
    inference = () => new Response(new ReadableStream<Uint8Array>({start(controller) {upstream = controller;}}));
    const verification = stub.fetch("https://chatgpt/verify", {method: "POST"});
    for (let i = 0; i < 100 && !upstream; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(upstream).toBeDefined();
    const disconnected = await stub.fetch("https://chatgpt/", {method: "DELETE"});
    expect(disconnected.status).toBe(200); await disconnected.text();
    expect((await connect(stub)).status).toBe(200);
    await runInDurableObject(stub, () => {
      upstream.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
      upstream.close();
    });
    const response = await verification;
    expect(response.status).toBe(409); await response.text();
    expect(await status(stub)).toMatchObject({connected: true, status: "connected_unverified"});
  });
});

describe('account model catalogues and model settings',()=>{
  it('requires owner authentication for model discovery and returns no invented models when disconnected',async()=>{
    expect((await exports.default.fetch('https://timber.test/v1/models')).status).toBe(401);
    const response=await newStub().fetch('https://chatgpt/models');
    expect(await response.json()).toMatchObject({models:[],connected:false});
    expect(modelCalls).toHaveLength(0);
  });

  it('uses the account token, preserves display ordering and caches only the current connection across eviction',async()=>{
    const stub=newStub();
    const credential=await credentials(String((await status(stub)).hostId));
    await connect(stub,credential);
    catalogResponse=()=>Response.json({models:[defaultModels.models[1],{slug:'hidden-internal',display_name:'Hidden',visibility:'hide'},defaultModels.models[0]]});
    const [a,b]=await Promise.all([stub.fetch('https://chatgpt/models'),stub.fetch('https://chatgpt/models')]);
    const catalog=await a.json<{models:{id:string}[];defaultModel:string}>();await b.text();
    expect(catalog.models.map(model=>model.id)).toEqual(['gpt-6-luna','gpt-6.1-sol']);
    expect(catalog.defaultModel).toBe('gpt-6-luna');
    expect(modelCalls).toEqual([`Bearer ${credential.access_token}`]);
    await abortAllDurableObjects();
    const recovered=bindings.CHATGPT.get(stub.id);
    expect((await (await recovered.fetch('https://chatgpt/models')).json<{models:unknown[]}>()).models).toHaveLength(2);
    expect(modelCalls).toHaveLength(1);
    await (await recovered.fetch('https://chatgpt/',{method:'DELETE'})).text();
    expect((await stored(recovered)).modelCatalog).toBeUndefined();
    expect((await (await recovered.fetch('https://chatgpt/models')).json<{models:unknown[]}>()).models).toEqual([]);
    await connect(recovered);
    await (await recovered.fetch('https://chatgpt/models')).text();
    expect(modelCalls).toHaveLength(2);
  });

  it('rejects a stale catalogue from a disconnected account and never saves or displays it for its replacement',async()=>{
    const stub=newStub();await connect(stub);
    let release!:(response:Response)=>void;
    catalogResponse=()=>new Promise<Response>(resolve=>{release=resolve;});
    const pending=stub.fetch('https://chatgpt/models');
    await expect.poll(()=>modelCalls.length).toBe(1);
    await (await stub.fetch('https://chatgpt/',{method:'DELETE'})).text();
    await connect(stub,await credentials(String((await status(stub)).hostId),{identity:{sub:'replacement'},access:{sub:'replacement'}}));
    await runInDurableObject(stub,()=>release(Response.json({models:[{slug:'old-account-private',display_name:'Old account',visibility:'list'}]})));
    const result=await (await pending).json<{models:unknown[];error:string}>();
    expect(result.models).toEqual([]);expect(result.error).toContain('connection changed');
    expect((await stored(stub)).modelCatalog).toBeUndefined();
    catalogResponse=()=>Response.json(defaultModels);
    const fresh=await (await stub.fetch('https://chatgpt/models')).json();
    expect(JSON.stringify(fresh)).not.toContain('old-account-private');
  });

  it('fails closed on catalogue errors without returning provider metadata or using a fallback',async()=>{
    const stub=newStub();await connect(stub);
    catalogResponse=()=>Response.json({private:'secret model provider details'},{status:503});
    const result=await (await stub.fetch('https://chatgpt/models')).json<{connected:boolean;models:unknown[];error:string}>();
    expect(result.connected).toBe(true);expect(result.models).toEqual([]);expect(result.error).toContain('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret model provider');
    const response=await infer(stub);expect(response.status).toBe(503);await response.text();
    expect(responseCalls).toHaveLength(0);
  });

  it('cannot send an already validated request under a replacement account',async()=>{
    const stub=newStub();await connect(stub);
    let validated=false,resume!:()=>void;
    await runInDurableObject(stub,instance=>{
      const auth=instance as unknown as {validateSettings:(input:unknown)=>Promise<unknown>};
      const original=auth.validateSettings.bind(auth);
      auth.validateSettings=async input=>{
        const result=await original(input);validated=true;
        await new Promise<void>(resolve=>{resume=resolve;});return result;
      };
    });
    const pending=infer(stub);
    await expect.poll(()=>validated).toBe(true);
    await (await stub.fetch('https://chatgpt/',{method:'DELETE'})).text();
    await connect(stub,await credentials(String((await status(stub)).hostId),{identity:{sub:'new-inference-account'},access:{sub:'new-inference-account'}}));
    await runInDurableObject(stub,()=>resume());
    const response=await pending;expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:{code:'chatgpt_connection_changed'}});
    expect(responseCalls).toHaveLength(0);
  });

  it('forwards the selected model, reasoning and supported Fast mode instead of forcing low',async()=>{
    const stub=newStub();await connect(stub);
    const selected=await infer(stub,{reasoning:{effort:'max',summary:'auto'},service_tier:'priority'});
    expect(selected.status).toBe(200);await selected.text();
    expect(responseCalls[0].payload).toMatchObject({model:'gpt-6.1-sol',reasoning:{effort:'max'},service_tier:'priority'});
    const other=await infer(stub,{model:'gpt-6-luna'});expect(other.status).toBe(200);await other.text();
    expect(responseCalls[1].payload.model).toBe('gpt-6-luna');expect(responseCalls[1].payload).not.toHaveProperty('reasoning');
    const automatic=await infer(stub);await automatic.text();
    expect(responseCalls[2].payload.reasoning).toMatchObject({effort:'medium'});
    for(const extra of [{reasoning:{effort:'ultra'}},{model:'gpt-6-luna',reasoning:{effort:'low'}},{model:'gpt-6-luna',service_tier:'fast'},{service_tier:'flex'}]) {
      const response=await infer(stub,extra);expect(response.status).toBe(400);await response.text();
    }
    expect(responseCalls).toHaveLength(3);
  });

  it('validates and persists bot model changes while clearing incompatible settings and preserving unrelated edits',async()=>{
    const stub=bindings.CHATGPT.get(bindings.CHATGPT.idFromName('owner'));
    await connect(stub);
    const api=(path:string,method='GET',body?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:`Bearer ${API_TOKEN}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    try {
      const models=await api('/v1/models');expect(models.status).toBe(200);
      expect((await models.json<{models:unknown[]}>()).models).toHaveLength(2);
      const creation=await api('/v1/bots','POST',{name:'Model selection',model:'gpt-6.1-sol',reasoningEffort:'max',fast:true});
      expect(creation.status).toBe(201);
      const {bot}=await creation.json<{bot:{id:string}}>();
      const url=`/v1/bots/${bot.id}`;
      const invalid=await api(url,'PATCH',{reasoningEffort:'ultra'});expect(invalid.status).toBe(400);await invalid.text();
      const changed=await api(url,'PATCH',{model:'gpt-6-luna',fast:false});
      expect(changed.status).toBe(200);const value=await changed.json<{bot:Record<string,unknown>}>();
      expect(value.bot.model).toBe('gpt-6-luna');expect(value.bot.fast).toBe(false);expect(value.bot).not.toHaveProperty('reasoningEffort');
      const responses=await Promise.all([api(url,'PATCH',{name:'Renamed'}),api(url,'PATCH',{model:'gpt-6.1-sol',reasoningEffort:'high'})]);
      for(const response of responses){expect(response.status).toBe(200);await response.text();}
      await abortAllDurableObjects();
      expect((await (await api(url)).json<{bot:unknown}>()).bot).toMatchObject({name:'Renamed',model:'gpt-6.1-sol',reasoningEffort:'high',fast:false});
    } finally {await (await bindings.CHATGPT.get(stub.id).fetch('https://chatgpt/',{method:'DELETE'})).text();}
  });
});
