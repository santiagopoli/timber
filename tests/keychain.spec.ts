import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import type {OwnerKeychainCoordinator} from '../apps/api/src/owner-keychain';
import type {Env} from '../apps/api/src/env';
import type {Bot,Run,SecretMetadata,SecureInputRequest,ComputerResult} from '@botspace/contracts';
import {OwnerKeychain,secretDestination} from '../apps/api/src/keychain';
import type {RuntimeHostToolRequest,RuntimeToolResult} from '../packages/runtime/src/types';
const bindings=env as unknown as Env;
const api=async(path:string,method='GET',body?:unknown)=>{const response=await exports.default.fetch(`https://timber.test/v1${path}`,{method,headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return new Response(await response.text(),{status:response.status,headers:response.headers});};
const owner=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
const stub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const payload=(overrides:Record<string,unknown>={})=>({operationId:crypto.randomUUID(),entries:[{name:'Example key',origin:'https://api.example.com',header:'Authorization',prefix:'Bearer ',value:'test-fixture-private-value-42'}],...overrides});
async function bot(){return (await (await api('/bots','POST',{name:'Keychain test'})).json<{bot:Bot}>()).bot;}
async function save(b:Bot,input:Record<string,unknown>=payload()){const response=await api(`/bots/${b.id}/keychain`,'POST',input);expect(response.status).toBe(200);return (await response.json<{entries:SecretMetadata[]}>()).entries;}
async function list(b:Bot){return (await api(`/bots/${b.id}/keychain`)).json<{entries:SecretMetadata[];requests:SecureInputRequest[]}>();}
async function sqlDump(b:Bot){return JSON.stringify(await Promise.all([owner(),stub(b)].map(target=>runInDurableObject(target,(_instance,state)=>{
  const tables=state.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
  return JSON.stringify(tables.map(({name})=>({name,rows:state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()})));
}))));}
async function useSecret(b:Bot,args:Record<string,unknown>,op=crypto.randomUUID()):Promise<ComputerResult>{return runInDurableObject(owner(),(_instance,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).call(op,args,new AbortController().signal,()=>{},b.id));}
async function waiting(b:Bot,text='fixture:secret'){const {run}=await (await api(`/bots/${b.id}/messages`,'POST',{text,operationId:crypto.randomUUID()})).json<{run:Run}>();for(let i=0;i<100;i++){const value=await list(b);if(value.requests.length)return {run,request:value.requests[0]};await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Secure request did not appear');}
beforeEach(async()=>{await api('/keychain');await runInDurableObject(owner(),(_i,state)=>{for(const name of ['keychain_entries','keychain_writes','secure_input_requests','keychain_calls','keychain_grants','keychain_deliveries'])state.storage.sql.exec(`DELETE FROM ${name}`);});});
afterEach(()=>vi.restoreAllMocks());

describe('owner keychain security and durable flow',()=>{
  it('requires owner authentication and bot membership; never offers a reveal route',async()=>{
    const b=await bot();expect((await exports.default.fetch(`https://timber.test/v1/bots/${b.id}/keychain`)).status).toBe(401);
    expect((await api(`/bots/${crypto.randomUUID()}/keychain`)).status).toBe(404);
    const [entry]=await save(b);expect((await api(`/bots/${b.id}/keychain/${entry.id}`)).status).toBe(404);
  });
  it('encrypts values, persists only keyed fingerprints and enforces bot permissions across restart',async()=>{
    const a=await bot(),b=await bot(),input=payload(),[entry]=await save(a,input);
    const stored=await sqlDump(a);expect(stored).not.toContain(input.entries[0].value);expect(stored).toContain('ciphertext');
    expect(JSON.stringify(await list(a))).not.toContain(input.entries[0].value);expect((await list(b)).entries[0].id).toBe(entry.id);expect((await list(b)).entries[0].botIds).not.toContain(b.id);
    await expect(useSecret(b,{secretId:entry.id,path:'/profile'})).rejects.toThrow('permission');
    await evictDurableObject(owner());expect((await list(a)).entries[0].id).toBe(entry.id);
    const copied=await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec<{data:string;envelope:string}>('SELECT data,envelope FROM keychain_entries WHERE id=?',entry.id).toArray()[0]);
    const other=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('other-owner'));
    await expect(runInDurableObject(other,(_i,state)=>{const store=new OwnerKeychain(state.storage,'other-owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});state.storage.sql.exec('INSERT INTO keychain_entries(id,data,envelope) VALUES(?,?,?)',entry.id,copied.data,copied.envelope);return store.call(crypto.randomUUID(),{secretId:entry.id,path:'/profile'},new AbortController().signal);})).rejects.toThrow();
  });
  it('deduplicates writes, detects conflicting retries and rejects stale replacement after revocation',async()=>{
    const b=await bot(),input=payload(),first=await save(b,input);expect(await save(b,input)).toEqual(first);expect((await list(b)).entries).toHaveLength(1);
    expect((await api(`/bots/${b.id}/keychain`,'POST',{...input,entries:[{...input.entries[0],value:'changed-fixture-value'}]})).status).toBe(409);
    const change=payload({entries:[{...input.entries[0],id:first[0].id,expectedRevision:1,value:'rotated-fixture-value'}]});
    const [updated]=await save(b,change);expect(updated.revision).toBe(2);
    expect((await api(`/bots/${b.id}/keychain`,'POST',{...change,operationId:crypto.randomUUID()})).status).toBe(409);
    expect((await api(`/bots/${b.id}/keychain/${updated.id}`,'DELETE')).status).toBe(200);
    expect((await list(b)).entries).toEqual([]);expect(await sqlDump(b)).not.toContain('rotated-fixture-value');
    expect((await api(`/bots/${b.id}/keychain`,'POST',payload({entries:[{...updated,expectedRevision:2,value:'another-fixture-value'}]}))).status).toBe(409);
    await expect(useSecret(b,{secretId:updated.id,path:'/'})).rejects.toThrow();
  });
  it('commits multiple inputs atomically and never persists a failed batch',async()=>{
    const b=await bot(),input=payload();const entries=[input.entries[0],{...input.entries[0],name:'Second',value:'another-fixture-value'}];expect(await save(b,payload({entries}))).toHaveLength(2);
    const response=await api(`/bots/${b.id}/keychain`,'POST',payload({entries:[...entries,{...entries[0],value:''}]}));expect(response.status).toBe(400);expect((await list(b)).entries).toHaveLength(2);
  });
  it('fails closed without the encryption key',async()=>{
    const b=await bot();await list(b);
    await expect(runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',undefined,()=>{}).save(payload(),()=>{}))).rejects.toThrow('not configured');
    expect((await list(b)).entries).toHaveLength(0);
  });
  it.each(['http://api.example.com','https://localhost','https://127.0.0.1','https://[::1]','https://foo.internal','https://api.example.com/path','https://user:password@api.example.com','https://api.example.com:444','https://api.example.com/?key=a'])('rejects unsafe or ambiguous destinations: %s',origin=>{expect(()=>secretDestination(origin)).toThrow();});
  it('injects only at the granted origin, redacts echoed and service-issued values, and never replays effects',async()=>{
    const b=await bot(),input=payload(),[entry]=await save(b,input),value=input.entries[0].value;
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${value}`);expect(init?.redirect).toBe('manual');return Response.json({profile:'Ada',echo:value,encoded:btoa(value),access_token:'service-issued-fixture-value',nested:{api_key:'other-fixture-key'}});});
    const op=crypto.randomUUID(),args={secretId:entry.id,path:'/profile',method:'POST',body:'{"name":"Ada"}'};
    const result=await useSecret(b,args,op);expect(result.status).toBe('completed');expect(result.output).toContain('Ada');expect(result.output).not.toContain(value);expect(result.output).not.toContain(btoa(value));expect(result.output).not.toContain('service-issued-fixture-value');
    expect(await useSecret(b,args,op)).toEqual(result);expect(transport).toHaveBeenCalledTimes(1);
    expect(await sqlDump(b)).not.toContain(value);
    for(const path of ['//evil.example.com/x','/\\evil.example.com/x','https://evil.example.com/x','/x#fragment'])await expect(useSecret(b,{secretId:entry.id,path})).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not forward credentials on redirects or expose provider error bodies',async()=>{
    const b=await bot(),[entry]=await save(b);
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('private-redirect-fixture',{status:302,headers:{location:'https://evil.example.com'}}));
    const result=await useSecret(b,{secretId:entry.id,path:'/redirect'});expect(result.status).toBe('failed');expect(JSON.stringify(result)).not.toContain('private-redirect-fixture');expect(transport).toHaveBeenCalledTimes(1);
    transport.mockRejectedValue(new Error('provider-error-containing-fixture-secret'));const op=crypto.randomUUID();const failed=await useSecret(b,{secretId:entry.id,path:'/mutate',method:'POST'},op);expect(failed.status).toBe('interrupted');expect(JSON.stringify(failed)).not.toContain('provider-error-containing');
    expect(await useSecret(b,{secretId:entry.id,path:'/mutate',method:'POST'},op)).toEqual(failed);expect(transport).toHaveBeenCalledTimes(2);
  });
  it('binds authenticated metadata to ciphertext, preventing destination swapping',async()=>{
    const b=await bot(),[entry]=await save(b);
    await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec('UPDATE keychain_entries SET data=? WHERE id=?',JSON.stringify({...entry,origin:'https://evil.example.com'}),entry.id));
    const transport=vi.spyOn(globalThis,'fetch');await expect(useSecret(b,{secretId:entry.id,path:'/'})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('fences revocation and Stop after decryption but before network dispatch',async()=>{
    const b=await bot(),[entry]=await save(b),transport=vi.spyOn(globalThis,'fetch');
    await expect(runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).call(crypto.randomUUID(),{secretId:entry.id,path:'/'},new AbortController().signal,()=>{throw new Error('Task stopped');}))).rejects.toThrow('Task stopped');
    await expect(runInDurableObject(owner(),(_i,state)=>{
      const chain=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});
      return chain.call(crypto.randomUUID(),{secretId:entry.id,path:'/'},new AbortController().signal,()=>chain.revoke(entry.id));
    })).rejects.toThrow('changed');expect(transport).not.toHaveBeenCalled();
  });
  it('does not replay a dispatch whose receipt was lost across restart',async()=>{
    const b=await bot(),[entry]=await save(b),op=crypto.randomUUID(),args={secretId:entry.id,path:'/',method:'POST'};
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({ok:true}));
    await useSecret(b,args,op);await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec('UPDATE keychain_calls SET result=NULL WHERE operation_id=?',op));await evictDurableObject(owner());
    expect((await useSecret(b,args,op)).status).toBe('interrupted');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent stale replacements and a denied commit leaves no ciphertext behind',async()=>{
    const b=await bot(),original=payload(),[entry]=await save(b,original);
    const responses=await Promise.all(['one','two'].map(value=>api(`/bots/${b.id}/keychain`,'POST',payload({entries:[{...original.entries[0],id:entry.id,expectedRevision:1,value:`concurrent-fixture-${value}`}]}))));expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    await expect(runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).save(payload(),()=>{throw new Error('Request stopped during encryption');}))).rejects.toThrow('stopped');expect((await list(b)).entries).toHaveLength(1);
  });
  it('keeps owner credentials when a bot is deleted and removes only its permissions',async()=>{
    const b=await bot(),[entry]=await save(b);expect((await api(`/bots/${b.id}`,'DELETE')).status).toBe(200);
    const entries=(await (await api('/keychain')).json<{entries:SecretMetadata[]}>()).entries;expect(entries[0].id).toBe(entry.id);expect(entries[0].botIds).toEqual([]);expect((await api(`/bots/${b.id}/keychain`)).status).toBe(404);
    const other=await bot();expect((await api(`/keychain/${entry.id}/permissions`,'POST',{botId:other.id,allowed:true})).status).toBe(200);expect((await list(other)).entries[0].botIds).toEqual([other.id]);
  });
  it('resumes a waiting bot once without ever placing the value in its transcript or native context',async()=>{
    const b=await bot(),{run,request}=await waiting(b);expect(request.status).toBe('pending');await evictDurableObject(stub(b));
    const input=payload({requestId:request.id});await save(b,input);await save(b,input);
    for(let i=0;i<100;i++){const result=await (await api(`/bots/${b.id}/runs/${run.id}`)).json<{run:Run}>();if(result.run.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    const state=await (await api(`/bots/${b.id}/runs/${run.id}`)).json<{run:Run}>();expect(state.run.status).toBe('completed');expect((await list(b)).requests[0].status).toBe('saved');
    const stored=await sqlDump(b);expect(stored).not.toContain(input.entries[0].value);
    const submissions=await runInDurableObject(stub(b),(_i,state)=>state.storage.sql.exec<{text:string}>('SELECT text FROM submissions WHERE operation_id=?',`secure:${request.id}`).toArray());expect(submissions).toHaveLength(1);expect(submissions[0].text).toContain('saved reference');
  });
  it('Stop invalidates old secure inputs and a stopped request cannot save or resume',async()=>{
    const b=await bot(),{run,request}=await waiting(b);await api(`/bots/${b.id}/runs/${run.id}/cancel`,'POST');
    expect((await list(b)).requests[0].status).toBe('cancelled');expect((await api(`/bots/${b.id}/keychain`,'POST',payload({requestId:request.id}))).status).toBe(409);expect((await list(b)).entries).toHaveLength(0);
  });
  it('stores arbitrary private text without setup and denies use until the bot prepares access',async()=>{
    const b=await bot(),value='arbitrary fixture text\nincluding multiple lines',input={operationId:crypto.randomUUID(),entries:[{value}]};
    const [entry]=await save(b,input);expect(entry.origin).toBe('');expect(entry.name).toBe('Private input');expect(await sqlDump(b)).not.toContain(value);
    await expect(useSecret(b,{secretId:entry.id,path:'/'})).rejects.toThrow('configure_secret');
  });
  it('uses bot-prepared metadata when filling a requested input, ignoring client destination overrides',async()=>{
    const b=await bot(),{request}=await waiting(b),[entry]=await save(b,{operationId:crypto.randomUUID(),requestId:request.id,entries:[{value:'fixture-only-input',origin:'https://evil.example.com',header:'X-Evil'}]});
    expect(entry.origin).toBe(request.origin);expect(entry.header).toBe(request.header);expect(entry.name).toBe(request.name);
  });
  it('authorizes a bot-prepared format, resumes once and keeps replacement setup internal',async()=>{
    const b=await bot(),value='fixture-private-opaque-text',[entry]=await save(b,{operationId:crypto.randomUUID(),entries:[{value}]}),{request}=await waiting(b,`fixture:configure:${entry.id}`);
    expect(request.secretId).toBe(entry.id);expect(request.expectedRevision).toBe(1);
    expect((await api(`/bots/${b.id}/keychain/requests/${request.id}/authorize`,'POST',{})).status).toBe(200);
    expect((await api(`/bots/${b.id}/keychain/requests/${request.id}/authorize`,'POST',{})).status).toBe(200);
    const [configured]=(await list(b)).entries;expect(configured.origin).toBe('https://api.example.com');expect(configured.header).toBe('X-API-Key');expect(configured.revision).toBe(2);expect(configured.name).toBe('Example API key');expect(configured.botIds).toContain(b.id);
    const [replaced]=await save(b,{operationId:crypto.randomUUID(),entries:[{id:entry.id,expectedRevision:2,value:'replacement-fixture-value'}]});expect(replaced.origin).toBe(configured.origin);expect(replaced.header).toBe(configured.header);expect(replaced.name).toBe(configured.name);
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{expect(new Headers(init?.headers).get('x-api-key')).toBe('replacement-fixture-value');expect(new Headers(init?.headers).get('api-version')).toBe('2026-01');return Response.json({ok:true});});
    expect((await useSecret(b,{secretId:entry.id,path:'/',headers:{'API-Version':'2026-01'}})).status).toBe('completed');expect(transport).toHaveBeenCalledTimes(1);
    for(const headers of [{'X-API-Key':'override'},{Authorization:'override'},{Cookie:'override'}])await expect(useSecret(b,{secretId:entry.id,path:'/',headers})).rejects.toThrow();
    expect(await sqlDump(b)).not.toContain(value);
    const count=await runInDurableObject(stub(b),(_i,state)=>state.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM submissions WHERE operation_id=?',`secure:${request.id}`).one().n);expect(count).toBe(1);
  });
  it.each(['stop','revoke','replace'])('invalidates pending access after %s',async(action)=>{
    const b=await bot(),[entry]=await save(b,{operationId:crypto.randomUUID(),entries:[{value:'fixture-private-value'}]}),{run,request}=await waiting(b,`fixture:configure:${entry.id}`);
    if(action==='stop')await api(`/bots/${b.id}/runs/${run.id}/cancel`,'POST');
    else if(action==='revoke')await api(`/bots/${b.id}/keychain/${entry.id}`,'DELETE');
    else await save(b,{operationId:crypto.randomUUID(),entries:[{id:entry.id,expectedRevision:1,value:'replacement-fixture-value'}]});
    const response=await api(`/bots/${b.id}/keychain/requests/${request.id}/authorize`,'POST',{});expect([403,404,409]).toContain(response.status);
    expect((await list(b)).entries.every(item=>item.origin==='')).toBe(true);
  });
  it('shares one owner entry only with explicitly permitted bots and revocation fences dispatch',async()=>{
    const a=await bot(),b=await bot(),[entry]=await save(a);
    expect((await list(b)).entries[0].id).toBe(entry.id);await expect(useSecret(b,{secretId:entry.id,path:'/'})).rejects.toThrow('permission');
    expect((await api(`/keychain/${entry.id}/permissions`,'POST',{botId:b.id,allowed:true})).status).toBe(200);
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({ok:true}));expect((await useSecret(b,{secretId:entry.id,path:'/'})).status).toBe('completed');
    await expect(runInDurableObject(owner(),(_i,state)=>{const store=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});return store.call(crypto.randomUUID(),{secretId:entry.id,path:'/'},new AbortController().signal,()=>store.grantAccess(entry.id,b.id,false),b.id);})).rejects.toThrow('revoked');
    expect(transport).toHaveBeenCalledTimes(1);expect((await list(a)).entries[0].botIds).toEqual([a.id]);
  });
  it('rejects forged permission metadata and public attempts to resume a private continuation',async()=>{
    const b=await bot(),[entry]=await save(b);await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec("UPDATE keychain_grants SET signature='forged' WHERE secret_id=?",entry.id));await expect(useSecret(b,{secretId:entry.id,path:'/'})).rejects.toThrow('permission');
    expect((await api(`/bots/${b.id}/_keychain/resume`,'POST',{})).status).toBe(404);
  });
  it('recovers an undelivered continuation after owner restart without repeating the save',async()=>{
    const b=await bot(),{run,request}=await waiting(b);
    await runInDurableObject(owner(),instance=>{
      const coordinator=(instance as unknown as {keychain:OwnerKeychainCoordinator}).keychain;
      const internal=coordinator as unknown as {botRequest:(id:string,path:string,input:unknown)=>Promise<Response>};
      const original=internal.botRequest.bind(coordinator);vi.spyOn(internal,'botRequest').mockImplementation((id,path,input)=>path==='resume'?Promise.resolve(Response.json({unavailable:true},{status:503})):original(id,path,input));
    });
    await save(b,payload({requestId:request.id}));
    expect(await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM keychain_deliveries').one().n)).toBe(1);
    vi.restoreAllMocks();await evictDurableObject(owner());
    await runInDurableObject(owner(),async(instance,state)=>{state.storage.sql.exec('UPDATE keychain_deliveries SET next_at=0');await (instance as unknown as {alarm:()=>Promise<void>}).alarm();});
    expect((await list(b)).entries).toHaveLength(1);
    for(let i=0;i<100;i++){const result=await (await api(`/bots/${b.id}/runs/${run.id}`)).json<{run:Run}>();if(result.run.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    expect((await (await api(`/bots/${b.id}/runs/${run.id}`)).json<{run:Run}>()).run.status).toBe('completed');
    expect(await runInDurableObject(stub(b),(_i,state)=>state.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM submissions WHERE operation_id=?',`secure:${request.id}`).one().n)).toBe(1);
    expect(await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM keychain_deliveries').one().n)).toBe(0);
  });
  it('rejects a signed grant copied to another bot and hides it from tool listings',async()=>{
    const a=await bot(),b=await bot(),[entry]=await save(a);
    await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec('INSERT INTO keychain_grants(secret_id,bot_id,data,signature) SELECT secret_id,?,data,signature FROM keychain_grants WHERE secret_id=? AND bot_id=?',b.id,entry.id,a.id));
    await expect(useSecret(b,{secretId:entry.id,path:'/'})).rejects.toThrow('permission');
    expect(await runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).permitted(b.id))).toEqual([]);
  });
  it('does not revive an old approval after access is revoked and granted again',async()=>{
    const b=await bot(),[entry]=await save(b,{operationId:crypto.randomUUID(),entries:[{value:'fixture-only-value'}]}),{request}=await waiting(b,`fixture:configure:${entry.id}`);
    for(const allowed of [false,true])expect((await api(`/keychain/${entry.id}/permissions`,'POST',{botId:b.id,allowed})).status).toBe(200);
    expect((await api(`/bots/${b.id}/keychain/requests/${request.id}/authorize`,'POST',{})).status).toBe(409);
    expect((await list(b)).entries[0].origin).toBe('');
  });
  it('prevents a child run from obtaining named-bot keychain access',async()=>{
    const b=await bot(),{run}=await waiting(b);
    const result=await runInDurableObject(stub(b),async(instance,state)=>{
      const row=state.storage.sql.exec<{data:string;native_operation_id:string}>('SELECT data,native_operation_id FROM runs WHERE id=?',run.id).toArray()[0];state.storage.sql.exec('UPDATE runs SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),subagentId:'fixture-child'}),run.id);
      return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:crypto.randomUUID(),runOperationId:row.native_operation_id,name:'list_secrets',arguments:{},signal:new AbortController().signal});
    });expect(result.status).toBe('failed');expect(JSON.stringify(result)).toContain('Only the named bot');
  });
});
