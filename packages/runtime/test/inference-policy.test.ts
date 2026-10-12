import {afterEach,expect,it,vi} from 'vitest';
import {fetchInference,inferenceCacheKey,inferenceIdleMs,workingContextModel,type InferenceProgress} from '../src/inference-policy.js';
afterEach(()=>vi.useRealTimers());
it('uses durable host/session affinity without exposing their identities or sharing bot caches',async()=>{
 const key=await inferenceCacheKey('private-bot-scope','private-session');expect(key).toMatch(/^[a-f0-9]{64}$/);
 expect(await inferenceCacheKey('private-bot-scope','private-session')).toBe(key);
 expect(await inferenceCacheKey('another-bot','private-session')).not.toBe(key);
 expect(await inferenceCacheKey('private-bot-scope','child-session')).not.toBe(key);
 expect(await inferenceCacheKey('private-bot-scope')).toBeUndefined();
});
it('limits the native working set while preserving small provider windows and their catalogue objects',()=>{
 const model={id:'large-model',contextWindow:1_050_000};expect(workingContextModel(model).contextWindow).toBe(128_000);expect(model.contextWindow).toBe(1_050_000);
 expect(workingContextModel({contextWindow:32_000}).contextWindow).toBe(32_000);
 expect(inferenceIdleMs({model:'gpt-6.1-sol'},120000)).toBe(600000);
 expect(inferenceIdleMs({model:'ordinary',reasoning:{effort:'max'}},100)).toBe(600000);
 expect(inferenceIdleMs({model:'ordinary'},120000)).toBe(300000);
});
it('releases an inference that never returns headers, even when its transport ignores cancellation',async()=>{
 vi.useFakeTimers();const events:InferenceProgress[]=[];
 const pending=fetchInference(()=>new Promise(()=>{}),new Request('https://fixture.test'),50,value=>events.push(value));
 const failed=expect(pending).rejects.toThrow('model_timeout');await vi.advanceTimersByTimeAsync(51);await failed;
 expect(events.at(-1)).toMatchObject({phase:'failed',idle:true,bytes:0});
});
it('allows total reasoning longer than the idle budget while stream traffic keeps arriving',async()=>{
 vi.useFakeTimers();const events:InferenceProgress[]=[];let output!:ReadableStreamDefaultController<Uint8Array>;
 const response=await fetchInference(async()=>new Response(new ReadableStream({start(controller){output=controller;}})),new Request('https://fixture.test'),50,value=>events.push(value));
 const reader=response.body!.getReader();
 for(let n=0;n<4;n++){const next=reader.read();await vi.advanceTimersByTimeAsync(40);output.enqueue(new Uint8Array([n]));expect((await next).done).toBe(false);}
 output.close();expect((await reader.read()).done).toBe(true);expect(events.at(-1)).toMatchObject({phase:'completed',bytes:4});expect(events.some(value=>value.idle)).toBe(false);
});
it('fails a stalled response body and keeps explicit Stop distinct from a timeout',async()=>{
 vi.useFakeTimers();const events:InferenceProgress[]=[];
 const response=await fetchInference(async()=>new Response(new ReadableStream()),new Request('https://fixture.test'),50,value=>events.push(value));
 const failed=expect(response.body!.getReader().read()).rejects.toThrow('model_timeout');await vi.advanceTimersByTimeAsync(51);await failed;expect(events.at(-1)).toMatchObject({phase:'failed',idle:true});
 const abort=new AbortController(),stopped:InferenceProgress[]=[];
 const pending=fetchInference(()=>new Promise(()=>{}),new Request('https://fixture.test',{signal:abort.signal}),50,value=>stopped.push(value));
 const rejected=expect(pending).rejects.toThrow('User stopped');abort.abort(new Error('User stopped'));await rejected;expect(stopped.at(-1)).toMatchObject({phase:'cancelled'});expect(stopped.at(-1)?.idle).toBeUndefined();
});
