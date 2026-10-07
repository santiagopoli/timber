import { describe, expect, it } from "vitest";
import worker from "../apps/api/src/index";
import type { Env } from "../apps/api/src/env";

describe("console entry points", () => {
  const requests:string[]=[];
  const bindings={ASSETS:{fetch:async(request:Request)=>{
    const url=new URL(request.url);requests.push(url.pathname);
    // Model the actual Cloudflare Assets canonicalization that caused the loop.
    if(url.pathname==="/index.html") return new Response(null,{status:307,headers:{location:"/"}});
    if(url.pathname==="/") return new Response('<script src="/console/assets/current.js"></script>',{headers:{"content-type":"text/html","cache-control":"public, max-age=0, must-revalidate"}});
    return new Response("export const current=true",{headers:{"content-type":"text/javascript","cache-control":"public, max-age=31536000, immutable"}});
  }}} as unknown as Env;

  it("reaches the current shell from every public alias in exactly one redirect", async()=>{
    for(const path of ["/","/console","/console/index.html"]) {
      requests.length=0;
      const first=await worker.fetch(new Request(`https://timber.test${path}?refresh=1`),bindings);
      expect(first.status).toBe(307);
      expect(first.headers.get("location")).toBe("/console/?refresh=1");
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(requests).toEqual([]);
      const next=await worker.fetch(new Request(new URL(first.headers.get("location")!,"https://timber.test")),bindings);
      expect(next.status).toBe(200);
      expect(await next.text()).toContain("/console/assets/current.js");
      expect(requests).toEqual(["/"]);
      expect(next.headers.get("cache-control")).toBe("no-store");
      expect(next.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(next.headers.get("referrer-policy")).toBe("strict-origin");
    }
  });

  it("preserves fingerprinted asset caching without exposing the API", async()=>{
    const asset=await worker.fetch(new Request("https://timber.test/console/assets/current.js"),bindings);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const api=await worker.fetch(new Request("https://timber.test/v1/bots"),{...bindings,BOTSPACE_API_TOKEN:"test-only-console-owner-token-000000"});
    expect(api.status).toBe(401);
  });
});
