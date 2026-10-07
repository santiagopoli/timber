import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const bindings=env as unknown as {GITHUB:DurableObjectNamespace;WORKSPACE:DurableObjectNamespace};
const BOT="11111111-1111-4111-8111-111111111111",OTHER="22222222-2222-4222-8222-222222222222";
const repository="owner/private-repo",origin="https://timber.test";
let pem:string,requests:{url:string;headers:Headers;payload:unknown}[],mcpCalls:number,pr:Record<string,unknown>|undefined,failMCP:boolean,loseMCPResponse:boolean,wrongInstallation:boolean,installationPermission:"read"|"write";
function stub() {return bindings.GITHUB.get(bindings.GITHUB.idFromName(crypto.randomUUID()));}
async function post(instance:DurableObjectStub,path:string,payload:unknown) {return instance.fetch(`https://github${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});}
async function record(instance:DurableObjectStub) {return runInDurableObject(instance,async(_value,state)=>Object.fromEntries(await state.storage.list()));}
async function setup(instance:DurableObjectStub,permission="write",options:{account?:boolean;settings?:boolean}={}) {
  const response=await post(instance,"/connect",{...(options.settings?{}:{botId:BOT,requestId:"connection-test"}),...(!options.account && !options.settings?{repository}:{}),permission,origin});
  const result=await response.json<{url:string}>();expect(response.status).toBe(200);
  const state=new URL(result.url).searchParams.get("state")!,cookie=`__Host-timber-github=${state}`;
  const start=await instance.fetch(result.url);expect(start.status).toBe(200);expect(await start.text()).toContain("Continue to GitHub");
  const manifest=await instance.fetch(`${origin}/github/setup/manifest?state=${state}&code=manifest-test-code`,{headers:{cookie},redirect:"manual"});expect(manifest.status).toBe(303);await manifest.text();
  const install=await instance.fetch(`${origin}/github/setup/install?state=${state}&installation_id=42`,{headers:{cookie},redirect:"manual"});expect(install.status).toBe(303);await install.text();
  const oauth=await instance.fetch(`${origin}/github/setup/oauth?state=${state}&code=oauth-test-code`,{headers:{cookie},redirect:"manual"});
  return {state,cookie,oauth};
}
beforeAll(async()=>{const keys=await generateKeyPair("RS256",{extractable:true});pem=await exportPKCS8(keys.privateKey);});
beforeEach(async()=>{
  const workspace=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
  await runInDurableObject(workspace,async(_instance,state)=>{
    state.storage.sql.exec("INSERT OR REPLACE INTO bots(id,data) VALUES(?,?)",BOT,JSON.stringify({id:BOT,name:"GitHub test",instructions:"",runtime:"pi",model:"@cf/test/mock",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
  });
  requests=[];mcpCalls=0;pr=undefined;failMCP=false;loseMCPResponse=false;wrongInstallation=false;installationPermission="write";
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url,headers=new Headers(init?.headers);
    let payload:unknown;try{payload=JSON.parse(String(init?.body));}catch{payload=String(init?.body??"");}
    requests.push({url,headers,payload});
    if(url==="https://api.github.com/app-manifests/manifest-test-code/conversions") return Response.json({id:123,slug:"timber-test",client_id:"Iv1.test",client_secret:"private-client-secret",pem,owner:{id:7}});
    if(url==="https://github.com/login/oauth/access_token") return Response.json({access_token:"private-user-token",refresh_token:"private-refresh-token",expires_in:28800});
    if(url==="https://api.github.com/user") return Response.json({id:7,login:"owner"});
    if(url==="https://api.github.com/app/installations/42") return Response.json({id:42,app_id:123,suspended_at:null,permissions:{contents:installationPermission,pull_requests:installationPermission},repository_selection:"all"});
    if(url==="https://api.github.com/user/installations?per_page=100&page=1") return Response.json({installations:[{id:wrongInstallation?43:42,app_id:123,account:{id:7}}]});
    if(url==="https://api.github.com/repos/owner/private-repo/installation") return Response.json({id:42,app_id:123,suspended_at:null,permissions:{contents:installationPermission,pull_requests:installationPermission}});
    if(url==="https://api.github.com/repos/owner/other/installation") return new Response("not selected",{status:404});
    if(url==="https://api.github.com/user/installations/42/repositories?per_page=100&page=1") return Response.json({total_count:1,repositories:[{id:10,full_name:"owner/private-repo",name:"private-repo",private:true,html_url:"https://github.com/owner/private-repo",default_branch:"main",description:null}]});
    if(url==="https://api.github.com/app/installations/42/access_tokens") return Response.json({token:"private-installation-token"});
    if(url==="https://api.github.com/repos/owner/private-repo") return Response.json({full_name:"Owner/private-repo"});
    if(url.startsWith("https://api.github.com/repos/owner/private-repo/pulls?")) return Response.json(pr?[pr]:[]);
    if(url.startsWith("https://github.com/owner/private-repo.git/")) return new Response("git transport fixture",{headers:{"content-type":"application/x-git-upload-pack-advertisement"}});
    if(url==="https://api.githubcopilot.com/mcp/") {
      const message=payload as {id?:number;method:string;params?:{arguments:Record<string,unknown>}};
      if(message.method==="initialize") return Response.json({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"test-github",version:"1"}}});
      if(message.method==="notifications/initialized") return new Response(null,{status:202});
      if(message.method==="tools/call") {
        mcpCalls++;
        if(failMCP) throw new Error("private-user-token must not escape");
        pr={number:12,html_url:"https://github.com/owner/private-repo/pull/12",title:"A change",state:"open",body:message.params?.arguments.body,head:{ref:"feature/test"},base:{ref:"main"}};
        if(loseMCPResponse) throw new Error("Connection lost after remote effect");
        return Response.json({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:"Created pull request"}]}});
      }
      return new Response(null,{status:405});
    }
    throw new Error(`Unexpected test network request: ${url}`);
  });
});
afterEach(()=>vi.restoreAllMocks());

describe("GitHub authorization host",()=>{
  it("requires owner authentication and does not expose internal capability minting",async()=>{
    for(const path of ["/v1/connections/github","/v1/connections/github/connect"]) {const response=await exports.default.fetch(`${origin}${path}`);expect(response.status).toBe(401);await response.text();}
    const response=await exports.default.fetch(`${origin}/github/git-capability`,{method:"POST",body:"{}"});expect(response.status).not.toBe(200);await response.text();
  });
  it("rejects foreign callback origins and replayed or browser-mismatched states",async()=>{
    const instance=stub();
    const invalid=await post(instance,"/connect",{botId:BOT,requestId:"request",repository,permission:"read",origin:"https://evil.example"});expect(invalid.status).toBe(503);await invalid.text();
    const result=await (await post(instance,"/connect",{botId:BOT,requestId:"request",repository,permission:"read",origin})).json<{url:string}>();
    const state=new URL(result.url).searchParams.get("state");
    const callback=await instance.fetch(`${origin}/github/setup/manifest?state=${state}&code=manifest-test-code`);expect(callback.status).toBe(403);await callback.text();expect(requests).toHaveLength(0);
  });
  it("encrypts credentials and shares one verified owner integration across bots within provider repository selection",async()=>{
    const instance=stub(),flow=await setup(instance);expect(flow.oauth.status).toBe(200);expect(flow.oauth.headers.get("location")).toBeNull();expect(flow.oauth.headers.get("set-cookie")).toContain("Max-Age=0");
    const success=await flow.oauth.text();expect(success).toContain("GitHub connected");expect(success).toContain("You can close this tab");expect(success).toContain("Timber account");
    const status=await (await instance.fetch("https://github/status")).json<{connected:boolean}>();expect(status.connected).toBe(true);
    const storage=JSON.stringify(await record(instance));expect(storage).not.toContain(pem);expect(storage).not.toContain("private-user-token");expect(storage).not.toContain("private-client-secret");
    const allowed=await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json();expect(allowed).toEqual({authorized:true});
    expect(await (await post(instance,"/authorize",{botId:OTHER,repository,permission:"write"})).json()).toEqual({authorized:true});
    expect(await (await post(instance,"/authorize",{botId:BOT,repository:"owner/other",permission:"read"})).json()).toEqual({authorized:false});
    const replay=await instance.fetch(`${origin}/github/setup/oauth?state=${flow.state}&code=oauth-test-code`,{headers:{cookie:flow.cookie},redirect:"manual"});expect(replay.status).toBe(409);await replay.text();
  });
  it("connects from account settings without a bot or repository and lists selected repositories for any bot",async()=>{
    const instance=stub(),flow=await setup(instance,"read",{settings:true});expect(flow.oauth.status).toBe(200);await flow.oauth.text();
    for(const botId of [BOT,OTHER]) {
      expect(await (await post(instance,"/authorize",{botId,permission:"read"})).json()).toEqual({authorized:true});
      const list=await post(instance,"/repositories",{botId});expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({repositories:[{repository:"owner/private-repo",private:true}],nextPage:null});
      expect(await (await post(instance,"/authorize",{botId,repository,permission:"write"})).json()).toEqual({authorized:true});
    }
    expect(Object.keys(await record(instance)).some(key=>key.startsWith("grant:") || key.startsWith("account-grant:"))).toBe(false);
  });
  it("migrates an existing owner OAuth connection from legacy grants without requiring another authorization",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    await runInDurableObject(instance,async(_instance,state)=>{
      const connection=await state.storage.get<Record<string,unknown>>("connection");delete connection!.installationId;
      await state.storage.put("connection",connection!);
      await state.storage.put(`grant:${BOT}:${repository}`,{botId:BOT,repository,permission:"read",installationId:42,revision:connection!.revision});
    });
    requests=[];
    expect(await (await post(instance,"/authorize",{botId:OTHER,repository,permission:"write"})).json()).toEqual({authorized:true});
    expect(requests.some(item=>item.url.includes("oauth"))).toBe(false);
    expect((await record(instance)).connection).toMatchObject({installationId:42});
  });
  it("recovers an already-connected installation through its verified OAuth account when old bot grants are gone",async()=>{
    const instance=stub(),flow=await setup(instance,"read",{settings:true});await flow.oauth.text();
    await runInDurableObject(instance,async(_instance,state)=>{const connection=await state.storage.get<Record<string,unknown>>("connection");delete connection!.installationId;await state.storage.put("connection",connection!);});
    requests=[];
    expect(await (await post(instance,"/authorize",{botId:OTHER,repository,permission:"write"})).json()).toEqual({authorized:true});
    expect(requests.some(item=>item.url.includes("oauth"))).toBe(false);
  });
  it("checks current provider access again after permission changes outside Timber",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    installationPermission="read";
    expect(await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json()).toEqual({authorized:false});
    installationPermission="write";
    expect(await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json()).toEqual({authorized:true});
  });
  it("does not trust a spoofed installation callback even when the App can access it",async()=>{
    wrongInstallation=true;const instance=stub(),flow=await setup(instance);expect(flow.oauth.status).toBe(403);await flow.oauth.text();
    expect(await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json()).toEqual({authorized:false});
    expect(requests.some(item=>item.url.endsWith("/access_tokens"))).toBe(false);
  });
  it("keeps read grants read-only and revokes bot capabilities on deletion",async()=>{
    installationPermission="read";const instance=stub(),flow=await setup(instance,"read");await flow.oauth.text();
    expect(await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json()).toEqual({authorized:false});
    const minted=await (await post(instance,"/git-capability",{botId:BOT,repository,permission:"read"})).json<{id:string;url:string;token:string}>();
    expect(minted.url).not.toContain(minted.token);expect(JSON.stringify(await record(instance))).not.toContain(minted.token);
    const read=await instance.fetch(`${minted.url}/info/refs?service=git-upload-pack`,{headers:{authorization:`Bearer ${minted.token}`}});expect(read.status).toBe(200);expect(await read.text()).toBe("git transport fixture");
    const git=requests.find(item=>item.url.startsWith("https://github.com/owner/private-repo.git/"))!;expect(atob(git.headers.get("authorization")!.slice(6))).toBe("x-access-token:private-installation-token");
    const write=await instance.fetch(`${minted.url}/info/refs?service=git-receive-pack`,{headers:{authorization:`Bearer ${minted.token}`}});expect(write.status).toBe(403);await write.text();
    const deletion=await instance.fetch(`https://github/bots/${BOT}`,{method:"DELETE"});await deletion.text();
    const revoked=await instance.fetch(`${minted.url}/info/refs?service=git-upload-pack`,{headers:{authorization:`Bearer ${minted.token}`}});expect(revoked.status).toBe(403);await revoked.text();
  });
  it("rejects cross-repository transport and clears access on disconnect",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    const minted=await (await post(instance,"/git-capability",{botId:BOT,repository,permission:"write"})).json<{id:string;url:string;token:string}>();
    const foreign=await instance.fetch(minted.url.replace("private-repo.git","other.git")+"/info/refs?service=git-upload-pack",{headers:{authorization:`Bearer ${minted.token}`}});expect(foreign.status).toBe(403);await foreign.text();
    await (await instance.fetch("https://github/status",{method:"DELETE"})).text();
    expect(await (await post(instance,"/authorize",{botId:BOT,repository,permission:"write"})).json()).toEqual({authorized:false});
    expect((await record(instance)).credentials).toBeUndefined();
  });
  it("checks capability expiry and explicit revocation before any GitHub transfer",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    const minted=await (await post(instance,"/git-capability",{botId:BOT,repository,permission:"read"})).json<{id:string;url:string;token:string}>();
    await runInDurableObject(instance,async(_value,state)=>{const cap=await state.storage.get<Record<string,unknown>>(`cap:${minted.id}`);await state.storage.put(`cap:${minted.id}`,{...cap,expiresAt:Date.now()-1});});
    const expired=await instance.fetch(`${minted.url}/info/refs?service=git-upload-pack`,{headers:{authorization:`Bearer ${minted.token}`}});expect(expired.status).toBe(403);await expired.text();
    const another=await (await post(instance,"/git-capability",{botId:BOT,repository,permission:"read"})).json<{id:string;url:string;token:string}>();
    await (await instance.fetch(`https://github/git-capability/${another.id}`,{method:"DELETE"})).text();
    const revoked=await instance.fetch(`${another.url}/info/refs?service=git-upload-pack`,{headers:{authorization:`Bearer ${another.token}`}});expect(revoked.status).toBe(403);await revoked.text();
    expect(requests.some(item=>item.url.startsWith("https://github.com/owner/private-repo.git/"))).toBe(false);
  });
  it("does not revive a deleted bot through a late OAuth callback",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    const connected=await (await post(instance,"/connect",{botId:BOT,requestId:"late-request",repository,permission:"write",origin})).json<{url:string}>();
    const state=new URL(connected.url).searchParams.get("state")!,cookie=`__Host-timber-github=${state}`;
    await (await instance.fetch(connected.url,{redirect:"manual"})).text();
    await (await instance.fetch(`${origin}/github/setup/install?state=${state}&installation_id=42`,{headers:{cookie},redirect:"manual"})).text();
    const workspace=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
    await runInDurableObject(workspace,async(_value,state)=>{state.storage.sql.exec("DELETE FROM bots WHERE id=?",BOT);});
    const callback=await instance.fetch(`${origin}/github/setup/oauth?state=${state}&code=oauth-test-code`,{headers:{cookie},redirect:"manual"});expect(callback.status).toBe(200);await callback.text();
    expect(await (await instance.fetch("https://github/status")).json()).toMatchObject({connected:true});
  });
});

describe("GitHub MCP writes",()=>{
  const operation={botId:BOT,repository,name:"create_pull_request",operationId:"pr-test",args:{head:"feature/test",base:"main",title:"A change",body:"Changed this"}};
  it("uses the real MCP protocol and reconciles duplicate PR creation by a stable marker",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    const first=await (await post(instance,"/mcp",operation)).json<{status:string;data:{number:number}}>();expect(first.status).toBe("completed");expect(first.data.number).toBe(12);expect(mcpCalls).toBe(1);
    const second=await (await post(instance,"/mcp",operation)).json();expect(second).toEqual(first);expect(mcpCalls).toBe(1);
    expect(requests.find(item=>item.url==="https://api.githubcopilot.com/mcp/")!.headers.get("authorization")).toBe("Bearer private-user-token");
    const conflict=await post(instance,"/mcp",{...operation,args:{...operation.args,title:"Other effect"}});expect(conflict.status).toBe(409);await conflict.text();
  });
  it("does not retry an uncertain remote write or return provider secrets",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();failMCP=true;
    const first=await post(instance,"/mcp",operation),text=await first.text();expect(text).toContain('"status":"interrupted"');expect(text).not.toContain("private-user-token");expect(mcpCalls).toBe(1);
    const second=await (await post(instance,"/mcp",operation)).json<{status:string}>();expect(second.status).toBe("interrupted");expect(mcpCalls).toBe(1);
  });
  it("recovers a successful PR whose MCP response was lost without creating it twice",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();loseMCPResponse=true;
    const first=await (await post(instance,"/mcp",operation)).json<{status:string}>();expect(first.status).toBe("interrupted");
    const second=await (await post(instance,"/mcp",operation)).json<{status:string;data:{number:number}}>();expect(second.status).toBe("completed");expect(second.data.number).toBe(12);expect(mcpCalls).toBe(1);
  });
  it("rejects tools and repository arguments outside the host allowlist",async()=>{
    const instance=stub(),flow=await setup(instance);await flow.oauth.text();
    for(const value of [{...operation,name:"delete_repository"},{...operation,args:{...operation.args,owner:"other"}}]) {const response=await post(instance,"/mcp",value);expect(response.status).toBeGreaterThanOrEqual(400);await response.text();}
    expect(mcpCalls).toBe(0);
  });
});
