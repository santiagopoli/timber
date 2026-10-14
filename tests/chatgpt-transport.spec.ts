import {env, exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe, expect, it} from 'vitest';

const namespace=(env as unknown as {REAL_CHATGPT_TRANSPORT:DurableObjectNamespace}).REAL_CHATGPT_TRANSPORT;
async function fixture(running=false) {
  const stub=namespace.get(namespace.idFromName(crypto.randomUUID()));
  const state={starts:0,stops:0,active:0,sizes:[] as string[],requests:[] as {path:string;method:string;headers:Headers;body:string}[],running};
  await runInDurableObject(stub,async instance=>{
    const container={images:{base:'test-only-image'},get running(){return state.running;},
      start(options:{instance:string}){state.starts++;state.sizes.push(options.instance);state.running=true;},async setInactivityTimeout(){},async destroy(){state.stops++;state.running=false;},
      getTcpPort(){return {async fetch(input:Request|string,init?:RequestInit){
        const request=input instanceof Request?input:new Request(input,init);const path=new URL(request.url).pathname;
        if(path==='/health')return Response.json({ok:true,active:state.active});
        state.requests.push({path,method:request.method,headers:new Headers(request.headers),body:request.method==='POST'?await request.text():''});
        return new Response('event: response.completed\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});
      }}}
    };
    Object.defineProperty(instance,'container',{get:()=>container});
  });
  return {stub,state};
}

describe('private ChatGPT server transport',()=>{
  it('retires the known unready lite instance once and keeps the standard transport across requests',async()=>{
    const {stub,state}=await fixture(true);
    for(let attempt=0;attempt<2;attempt++){
      const response=await stub.fetch('https://transport/v1/models',{headers:{'x-timber-internal':'chatgpt-transport',authorization:'Bearer test-only-oauth'}});
      expect(response.status).toBe(200);await response.text();
    }
    expect(state.stops).toBe(1);expect(state.starts).toBe(1);expect(state.sizes).toEqual(['standard-1']);
  });
  it('blocks public access, other paths, missing internal authority and wrong methods before boot',async()=>{
    const {stub,state}=await fixture();
    for(const [path,method,headers] of [['/v1/models','GET',{}],['/exec','POST',{'x-timber-internal':'chatgpt-transport'}],['/v1/models?url=other','GET',{'x-timber-internal':'chatgpt-transport'}],['/v1/models','POST',{'x-timber-internal':'chatgpt-transport'}]] as const){
      const response=await stub.fetch(`https://transport${path}`,{method,headers});expect(response.status).toBe(404);await response.text();
    }
    const response=await exports.default.fetch('https://timber.test/v1/connections/chatgpt/transport',{headers:{authorization:'Bearer test-only-botspace-owner-token-000000','x-timber-internal':'chatgpt-transport'}});
    expect(response.status).toBe(404);await response.text();expect(state.starts).toBe(0);expect(state.requests).toHaveLength(0);
  });
  it('starts only one transport, strips unrelated headers, and never persists OAuth or input',async()=>{
    const {stub,state}=await fixture();
    const responses=await Promise.all([1,2].map(()=>stub.fetch('https://transport/v1/responses',{method:'POST',
      headers:{'x-timber-internal':'chatgpt-transport',authorization:'Bearer test-only-oauth-canary',cookie:'test-only-owner-cookie',session_id:'a'.repeat(64)},body:'test-only-input-canary'})));
    for(const response of responses){expect(response.status).toBe(200);expect(await response.text()).toContain('response.completed');}
    expect(state.starts).toBe(1);expect(state.requests).toHaveLength(2);
    for(const call of state.requests){expect(call.headers.get('authorization')).toBe('Bearer test-only-oauth-canary');expect(call.headers.get('cookie')).toBeNull();expect(call.headers.get('x-timber-internal')).toBeNull();expect(call.headers.get('session_id')).toBe('a'.repeat(64));}
    const saved=await runInDurableObject(stub,async(_instance,context)=>JSON.stringify(Object.fromEntries(await context.storage.list())));
    expect(saved).not.toContain('test-only-oauth-canary');expect(saved).not.toContain('test-only-input-canary');
  });
  it('idle shutdown preserves active responses and stops only once they are finished',async()=>{
    const {stub,state}=await fixture();
    const response=await stub.fetch('https://transport/v1/models',{headers:{'x-timber-internal':'chatgpt-transport',authorization:'Bearer test-only-oauth'}});await response.text();
    state.active=1;
    await runInDurableObject(stub,async(instance,context)=>{await context.storage.put('lastActivity',Date.now()-10*60_000);await (instance as unknown as {alarm():Promise<void>}).alarm();});
    expect(state.stops).toBe(0);
    state.active=0;
    await runInDurableObject(stub,async instance=>{await (instance as unknown as {alarm():Promise<void>}).alarm();});
    expect(state.stops).toBe(1);
  });
});
