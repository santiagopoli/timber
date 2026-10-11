import {describe,it,expect} from 'vitest';
import worker from '../apps/api/src/index';
import type {Env} from '../apps/api/src/env';

describe('audio console content security policy',()=>{
  it('permits private same-origin and temporary Blob audio without relaxing scripts, network or embedded content',async()=>{
    const env={ASSETS:{fetch:async()=>new Response('<!doctype html><title>Public console shell</title>',{headers:{'content-type':'text/html'}})}} as unknown as Env;
    const response=await worker.fetch(new Request('https://timber.test/console/'),env);
    expect(response.status).toBe(200);
    const policy=response.headers.get('content-security-policy')!;
    expect(policy).toContain("media-src 'self' blob:;");
    expect(policy).toContain("default-src 'self';");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'self' wss://timber.test;");
    expect(policy).toContain("object-src 'none';");
    expect(policy).toContain("frame-ancestors 'none';");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('media-src *');
  });
});
