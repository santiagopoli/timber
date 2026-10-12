import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {OwnerKeychainCoordinator} from '../apps/api/src/owner-keychain';
import type {Env} from '../apps/api/src/env';
import type {Bot,Run,SecretMetadata,SecureInputRequest,ComputerResult} from '@botspace/contracts';
import {OwnerKeychain,secretDestination} from '../apps/api/src/keychain';
import {validateHostArguments} from '../apps/api/src/host-tools';
import {ComputerDO} from '../packages/computer/src';
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
async function nameSecret(b:Bot,run:Run,entry:SecretMetadata,name:string,op=crypto.randomUUID()):Promise<RuntimeToolResult>{return runInDurableObject(stub(b),(instance,state)=>{
  const row=state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',run.id).one();
  return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:op,runOperationId:row.native_operation_id,name:'name_secret',arguments:{secretId:entry.id,name,expectedRevision:entry.revision},signal:new AbortController().signal});
});}
async function waiting(b:Bot,text='fixture:secret'){const {run}=await (await api(`/bots/${b.id}/messages`,'POST',{text,operationId:crypto.randomUUID()})).json<{run:Run}>();for(let i=0;i<100;i++){const value=await list(b);if(value.requests.length)return {run,request:value.requests[0]};await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Secure request did not appear');}

async function deployFixture(legacy=false){
  const b=await bot();
  const entries=legacy?[
    {name:'Fixture Cloudflare key',origin:'https://api.cloudflare.com',header:'X-Auth-Key',prefix:'',value:'synthetic-only-cf-legacy-key'},
    {name:'Fixture Cloudflare email',origin:'https://api.cloudflare.com',header:'X-Auth-Email',prefix:'',value:'synthetic-only@example.invalid'}
  ]:[{name:'Fixture Cloudflare token',origin:'https://api.cloudflare.com',header:'Authorization',prefix:'Bearer ',value:'synthetic-only-cf-token'}];
  const refs=await save(b,payload({entries})),{run}=await waiting(b);
  const input={operationId:crypto.randomUUID(),botId:b.id,repository:'example/worker',commit:'a'.repeat(40),artifactDigest:`sha256:${'b'.repeat(64)}`,artifactPath:'dist/worker.js',accountId:'c'.repeat(32),workerName:'fixture-worker',refs:refs.map(({id,revision})=>({id,revision}))};
  const response=await api('/keychain/deploy-plans','POST',input);expect(response.status).toBe(201);
  const {plan}=await response.json<{plan:{id:string;revision:number;pin:{repository:string;commit:string;artifactDigest:`sha256:${string}`;artifactPath:string;accountId:string;workerName:string;destination:string}}}>();
  return {b,run,refs,input,plan};
}
async function deployTool(b:Bot,run:Run,plan:{id:string;revision:number},op=crypto.randomUUID()):Promise<RuntimeToolResult>{
  return runInDurableObject(stub(b),(instance,state)=>{
    const row=state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',run.id).one();
    return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:op,runOperationId:row.native_operation_id,name:'secure_worker_deploy',arguments:{planId:plan.id,expectedRevision:plan.revision},signal:new AbortController().signal});
  });
}
beforeEach(async()=>{await api('/keychain');await runInDurableObject(owner(),(_i,state)=>{for(const name of ['keychain_entries','keychain_writes','keychain_names','secure_input_requests','keychain_calls','keychain_grants','keychain_deliveries','secure_worker_deployments','secure_worker_deploy_plans','secure_worker_deploy_plan_ops'])state.storage.sql.exec(`DELETE FROM ${name}`);});});
afterEach(()=>vi.restoreAllMocks());

describe('owner keychain security and durable flow',()=>{
  it('exposes an empty metadata-only capability schema and rejects temporary-agent use',async()=>{
    expect(()=>validateHostArguments('secure_worker_deploy_capabilities',{})).not.toThrow();
    expect(()=>validateHostArguments('secure_worker_deploy_capabilities',{botId:crypto.randomUUID()})).toThrow('Invalid botId');
    const b=await bot(),{run}=await waiting(b);
    const result=await runInDurableObject(stub(b),(instance,state)=>{
      state.storage.sql.exec("UPDATE runs SET data=json_set(data,'$.subagentId','temporary-agent') WHERE id=?",run.id);
      const row=state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',run.id).one();
      return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:crypto.randomUUID(),runOperationId:row.native_operation_id,name:'secure_worker_deploy_capabilities',arguments:{},signal:new AbortController().signal});
    });
    expect(result.status).toBe('failed');expect(result.error).toContain('Only the named bot');
  });
  it('probes only the scoped Computer canary with run fences and no keychain lookup',async()=>{
    const b={id:crypto.randomUUID(),name:'Capability probe'} as Bot;
    let computerCalls=0,checks=0,stopAfterProbe=false,probeFinished=false;
    const coordinator=Object.create(OwnerKeychainCoordinator.prototype) as any;
    coordinator.ctx={storage:{sql:{exec:(query:string)=>({toArray:()=>query.includes('SELECT data FROM bots')?[{data:JSON.stringify(b)}]:[]})}}};
    coordinator.env={BOT:{idFromName:(id:string)=>id,get:()=>({fetch:async()=>{checks++;return new Response(null,{status:stopAfterProbe&&probeFinished?409:200})}})},COMPUTER:{idFromName:(id:string)=>id,get:(id:string)=>({fetch:async(request:Request)=>{computerCalls++;expect(id).toBe(b.id);expect(request.url).toContain('/secure-deploy/capabilities');expect(request.headers.get('x-timber-bot-id')).toBe(b.id);probeFinished=true;return Response.json({secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1',credential:'must-not-escape'});}})}};
    const input={name:'secure_worker_deploy_capabilities',arguments:{},botId:b.id,runId:crypto.randomUUID(),nativeOperationId:crypto.randomUUID(),operationId:crypto.randomUUID()};
    const response=await coordinator.tool(input,new AbortController().signal),value=await response.json();
    expect(value).toEqual({capability:{secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1'}});
    expect(computerCalls).toBe(1);expect(checks).toBe(3);expect(JSON.stringify(value)).not.toContain('must-not-escape');
    stopAfterProbe=true;probeFinished=false;checks=0;computerCalls=0;
    await expect(coordinator.tool(input,new AbortController().signal)).rejects.toThrow('task is no longer active');
    expect(computerCalls).toBe(1);expect(checks).toBe(3);
  });
  it('validates the bounded composite secret_request host schema',()=>{
    const ids=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
    expect(()=>validateHostArguments('secret_request',{secretId:ids[0],path:'/',additionalSecretIds:ids.slice(1)})).not.toThrow();
    for(const additionalSecretIds of [[],[ids[1],ids[1]],[ids[1],ids[2],ids[3],crypto.randomUUID()],[ids[1],23]])
      expect(()=>validateHostArguments('secret_request',{secretId:ids[0],path:'/',additionalSecretIds})).toThrow('Invalid additionalSecretIds');
    expect(()=>validateHostArguments('name_secret',{secretId:ids[0],name:'Fixture',expectedRevision:1})).not.toThrow();
    expect(()=>validateHostArguments('name_secret',{secretId:ids[0],name:'Fixture',expectedRevision:0})).toThrow('Invalid expectedRevision');
  });
  it('renames without revealing or replacing a value and preserves both bot grants across restart',async()=>{
    const a=await bot(),b=await bot(),input=payload(),[entry]=await save(a,input);
    await api(`/keychain/${entry.id}/permissions`,'POST',{botId:b.id,allowed:true});
    const grants=()=>runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec('SELECT * FROM keychain_grants WHERE secret_id=? ORDER BY bot_id',entry.id).toArray());
    const before=await grants();
    const rename={name:'Cloudflare · Production',expectedRevision:entry.revision,operationId:crypto.randomUUID()};
    const response=await api(`/bots/${a.id}/keychain/${entry.id}`,'PATCH',rename);expect(response.status).toBe(200);
    const result=await response.json<{entries:SecretMetadata[]}>();expect(result.entries[0]).toMatchObject({...entry,name:rename.name,revision:2,updatedAt:expect.any(String),botIds:expect.arrayContaining([a.id,b.id])});
    expect(JSON.stringify(result)).not.toContain(input.entries[0].value);expect(await grants()).toEqual(before);
    await evictDurableObject(owner());expect((await list(b)).entries[0].name).toBe(rename.name);
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${input.entries[0].value}`);return Response.json({ok:true});});
    expect((await useSecret(a,{secretId:entry.id,path:'/profile'})).status).toBe('completed');expect((await useSecret(b,{secretId:entry.id,path:'/profile'})).status).toBe('completed');expect(transport).toHaveBeenCalledTimes(2);
    expect(await sqlDump(a)).not.toContain(input.entries[0].value);
  });
  it('deduplicates rename retries and rejects stale or conflicting renames without undoing later names',async()=>{
    const b=await bot(),[entry]=await save(b),path=`/keychain/${entry.id}`,input={name:'First name',expectedRevision:1,operationId:crypto.randomUUID()};
    expect((await api(path,'PATCH',input)).status).toBe(200);await evictDurableObject(owner());expect((await api(path,'PATCH',input)).status).toBe(200);
    expect((await list(b)).entries[0].revision).toBe(2);
    expect((await api(path,'PATCH',{...input,name:'Conflicting name'})).status).toBe(409);
    expect((await api(path,'PATCH',{...input,operationId:crypto.randomUUID()})).status).toBe(409);
    const concurrent=await Promise.all(['Second name','Other name'].map(name=>api(path,'PATCH',{name,expectedRevision:2,operationId:crypto.randomUUID()})));expect(concurrent.map(item=>item.status).sort()).toEqual([200,409]);
    const latest=(await list(b)).entries[0];expect((await api(path,'PATCH',input)).status).toBe(200);expect((await list(b)).entries[0]).toEqual(latest);
    await api(path,'DELETE');expect((await api(path,'PATCH',input)).status).toBe(404);expect((await list(b)).entries).toEqual([]);
  });
  it('requires authentication, membership and a valid metadata-only rename',async()=>{
    const b=await bot(),[entry]=await save(b),input={name:'Cloudflare',expectedRevision:1,operationId:crypto.randomUUID()};
    expect((await exports.default.fetch(`https://timber.test/v1/keychain/${entry.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status).toBe(401);
    expect((await api(`/bots/${crypto.randomUUID()}/keychain/${entry.id}`,'PATCH',input)).status).toBe(404);
    for(const name of ['', '   ','line\nbreak','x'.repeat(81)])expect((await api(`/keychain/${entry.id}`,'PATCH',{...input,name})).status).toBe(400);
    for(const field of ['value','origin','botIds'])expect((await api(`/keychain/${entry.id}`,'PATCH',{...input,[field]:'not-allowed'})).status).toBe(400);
    expect((await list(b)).entries[0].name).toBe(entry.name);
  });
  it('lets a permitted named bot name an unnamed input while preserving owner names and refusing other bots',async()=>{
    const a=await bot(),b=await bot(),[entry]=await save(a,payload({entries:[{value:'fixture-only-value'}]})),{run}=await waiting(a),other=await waiting(b);
    await expect(nameSecret(b,other.run,entry,'Unauthorized name')).rejects.toThrow('permission');
    const op=crypto.randomUUID();expect((await nameSecret(a,run,entry,'Cloudflare API key',op)).status).toBe('completed');
    expect((await nameSecret(a,run,entry,'Cloudflare API key',op)).status).toBe('completed');
    const named=(await list(a)).entries[0];expect(named).toMatchObject({id:entry.id,name:'Cloudflare API key',revision:2,botIds:[a.id],origin:''});
    expect((await api(`/keychain/${entry.id}`,'PATCH',{name:'My production key',expectedRevision:2,operationId:crypto.randomUUID()})).status).toBe(200);
    const owned=(await list(a)).entries[0];expect((await nameSecret(a,run,owned,'Different agent label')).status).toBe('completed');expect((await list(a)).entries[0].name).toBe('My production key');
    const request=await runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).requestInput('fixture-preserve-name',{secretId:entry.id,name:'Another label',origin:'https://api.example.com',purpose:'Use the key'},run.id,'fixture-operation',a.id));expect(request.name).toBe('My production key');
    await api(`/keychain/${entry.id}/permissions`,'POST',{botId:a.id,allowed:false});await expect(nameSecret(a,run,named,'Cloudflare API key',op)).rejects.toThrow('permission');
    expect(await sqlDump(a)).not.toContain('fixture-only-value');
  });
  it.each(['revoke','permission','stop'])('fences a rename when %s races its encrypted update',async action=>{
    const b=await bot(),[entry]=await save(b,payload({entries:[{value:'fixture-only-value'}]}));
    await expect(runInDurableObject(owner(),(_i,state)=>{
      const store=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});
      return store.rename('race',entry.id,{name:'New name',expectedRevision:1},async()=>{if(action==='revoke')store.revoke(entry.id);else if(action==='permission')await store.grantAccess(entry.id,b.id,false);else throw new Error('Task stopped');},b.id);
    })).rejects.toThrow();
    const entries=(await list(b)).entries;if(action==='revoke')expect(entries).toHaveLength(0);else expect(entries[0].name).toBe('Private input');
  });
  it('requires owner authentication and bot membership; never offers a reveal route',async()=>{
    const b=await bot();expect((await exports.default.fetch(`https://timber.test/v1/bots/${b.id}/keychain`)).status).toBe(401);
    expect((await api(`/bots/${crypto.randomUUID()}/keychain`)).status).toBe(404);
    const [entry]=await save(b);expect((await api(`/bots/${b.id}/keychain/${entry.id}`)).status).toBe(404);
  });
  it('creates an owner-pinned plan and routes only planId/revision to a hard-fail-closed ComputerDO',async()=>{
    const b=await bot(),[entry]=await save(b,payload({entries:[{name:'Cloudflare deploy key',origin:'https://api.cloudflare.com',header:'Authorization',prefix:'Bearer ',value:'test-fixture-cloudflare-secret'}]})),{run}=await waiting(b);
    const body={operationId:crypto.randomUUID(),botId:b.id,repository:'example/worker',commit:'a'.repeat(40),artifactDigest:`sha256:${'b'.repeat(64)}`,artifactPath:'dist/worker.js',accountId:'c'.repeat(32),workerName:'production-worker',refs:[{id:entry.id,revision:entry.revision}]};
    const planResponse=await api('/keychain/deploy-plans','POST',body);expect(planResponse.status).toBe(201);const {plan}=await planResponse.json<{plan:{id:string;revision:number}}>();
    expect((await api('/keychain/deploy-plans')).status).toBe(200);
    expect((await exports.default.fetch('https://timber.test/v1/keychain/deploy-plans',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(401);
    expect((await api('/keychain/deploy-plans','POST',{...body,repository:'../evil'})).status).toBe(400);
    expect((await api(`/bots/${b.id}/keychain/deploy-plans`,'POST',body)).status).toBe(403);
    const native=await runInDurableObject(stub(b),(_instance,state)=>state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',run.id).one().native_operation_id);
    const decrypt=vi.spyOn(crypto.subtle,'decrypt'),paths:string[]=[],original=ComputerDO.prototype.fetch;
    const computer=vi.spyOn(ComputerDO.prototype,'fetch').mockImplementation(function(this:ComputerDO,request:Request){paths.push(new URL(request.url).pathname);return original.call(this,request);});
    const result=await runInDurableObject(stub(b),(instance)=>{
      return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:crypto.randomUUID(),runOperationId:native,name:'secure_worker_deploy',arguments:{planId:plan.id,expectedRevision:plan.revision},signal:new AbortController().signal});
    });
    expect(result).toMatchObject({status:'failed',error:'This Computer does not report a ready isolated deploy runner. No credential was sent.'});
    expect(paths).toEqual(['/secure-deploy/capabilities']);expect(decrypt).not.toHaveBeenCalled();expect(computer).toHaveBeenCalledTimes(1);
    expect(await sqlDump(b)).not.toContain('test-fixture-cloudflare-secret');
    expect(await runInDurableObject(owner(),(_instance,state)=>state.storage.sql.exec('SELECT operation_id FROM keychain_calls').toArray())).toEqual([]);
    expect(await runInDurableObject(stub(b),(_instance,state)=>state.storage.sql.exec('SELECT * FROM run_processes').toArray())).toEqual([]);
    await expect(runInDurableObject(stub(b),(instance)=>(instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:crypto.randomUUID(),runOperationId:native,name:'secure_worker_deploy',arguments:{planId:plan.id,expectedRevision:plan.revision+1},signal:new AbortController().signal}))).rejects.toThrow('revision is stale');
    expect(paths).toEqual(['/secure-deploy/capabilities']);expect(decrypt).not.toHaveBeenCalled();
    expect(validateHostArguments('secure_worker_deploy',{planId:plan.id,expectedRevision:plan.revision})).toBeUndefined();
    expect(()=>validateHostArguments('secure_worker_deploy',{planId:plan.id,expectedRevision:plan.revision,repository:'attacker/target'})).toThrow();
  });

  it('exposes owner-authenticated live Computer deploy readiness without credentials',async()=>{
    const b=await bot(),called:string[]=[];
    vi.spyOn(ComputerDO.prototype,'fetch').mockImplementation(async function(request:Request){called.push(new URL(request.url).pathname);return Response.json({secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1'});});
    expect((await exports.default.fetch(`https://timber.test/v1/keychain/deploy-capabilities?botId=${b.id}`)).status).toBe(401);
    const response=await api(`/keychain/deploy-capabilities?botId=${b.id}`);expect(response.status).toBe(200);expect(await response.json()).toEqual({capability:{secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1'}});
    expect(called).toEqual(['/secure-deploy/capabilities']);
    expect((await api(`/bots/${b.id}/keychain/deploy-capabilities?botId=${b.id}`)).status).toBe(403);
  });

  it('dispatches an owner-pinned artifact through only the dedicated private Computer API',async()=>{
    const {b,run,plan}=await deployFixture(),value='synthetic-only-cf-token';
    const paths:string[]=[],payloads:Record<string,unknown>[]=[];
    vi.spyOn(ComputerDO.prototype,'fetch').mockImplementation(async function(_request:Request){
      const path=new URL(_request.url).pathname;paths.push(path);
      if(path==='/secure-deploy/capabilities')return Response.json({secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1'});
      if(path==='/secure-deploy'){
        const body=await _request.clone().json() as Record<string,unknown>;payloads.push(body);
        const verified=await owner().fetch(new Request('https://workspace/keychain/deploy-verify',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'computer'},body:JSON.stringify({authorization:body.authorization})}));
        if(!verified.ok)return Response.json({operationId:String(body.operationId),status:'rejected',code:'invalid_authorization'});
        await verified.body?.cancel();return Response.json({operationId:String(body.operationId),status:'completed',code:'deploy_accepted'});
      }
      return new Response(null,{status:404});
    });
    const result=await deployTool(b,run,plan,crypto.randomUUID());
    expect(result.status).toBe('completed');expect(paths).toEqual(['/secure-deploy/capabilities','/secure-deploy']);
    const sent=payloads[0] as {pin:{artifactPath:string};credentials:Array<{header:string;prefix:string;value:string}>;authorization:{refs:Array<{id:string;revision:number}>;pin:{artifactPath:string};expiresAt:number;signature:string;botId:string;runId:string;nativeOperationId:string}};
    expect(sent.pin.artifactPath).toBe('dist/worker.js');expect(sent.authorization.refs).toHaveLength(1);expect(sent.credentials).toEqual([{refId:(await list(b)).entries[0].id,revision:1,header:'Authorization',prefix:'Bearer ',value}]);
    expect(sent.authorization.pin.artifactPath).toBe('dist/worker.js');expect(sent.authorization.expiresAt-Date.now()).toBeLessThanOrEqual(55_000);expect(sent.authorization.expiresAt).toBeGreaterThan(Date.now());
    const tampered={...sent.authorization,pin:{...sent.authorization.pin,artifactPath:'evil/worker.js'}};
    const rejected=await owner().fetch(new Request('https://workspace/keychain/deploy-verify',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'computer'},body:JSON.stringify({authorization:tampered})}));expect(rejected.status).toBe(409);await rejected.body?.cancel();
    expect(paths).not.toContain('/actions');expect(await sqlDump(b)).not.toContain(value);expect(JSON.stringify(result)).not.toContain(value);
  });

  it('accepts only owner-authorized legacy key/email pair and never stores the credentials',async()=>{
    const {b,run,refs,input,plan}=await deployFixture(true);
    const decrypt=vi.spyOn(crypto.subtle,'decrypt');
    expect((await deployTool(b,run,plan)).status).toBe('failed');expect(decrypt).not.toHaveBeenCalled();
    const duplicate=await api('/keychain/deploy-plans','POST',input);expect(duplicate.status).toBe(200);expect((await duplicate.json<{plan:{id:string}}>()).plan.id).toBe(plan.id);
    expect((await api('/keychain/deploy-plans','POST',{...input,workerName:'other-worker'})).status).toBe(409);
    for(const body of [{...input,operationId:crypto.randomUUID(),refs:[input.refs[0]]},{...input,operationId:crypto.randomUUID(),refs:[input.refs[0],input.refs[0]]},{...input,operationId:crypto.randomUUID(),destination:'https://evil.invalid'},{...input,operationId:crypto.randomUUID(),repository:'owner/..'}])expect((await api('/keychain/deploy-plans','POST',body)).status).toBeGreaterThanOrEqual(400);
    await api(`/keychain/${refs[0].id}/permissions`,'POST',{botId:b.id,allowed:false});
    expect((await api('/keychain/deploy-plans','POST',{...input,operationId:crypto.randomUUID()})).status).toBe(403);
    for(const value of ['synthetic-only-cf-legacy-key','synthetic-only@example.invalid'])expect(await sqlDump(b)).not.toContain(value);
  });
  it('revoked plans, retarget attempts and other bots cannot reach the provider',async()=>{
    const {b,run,plan}=await deployFixture(),other=await bot(),otherRun=(await waiting(other)).run;
    const computer=vi.spyOn(ComputerDO.prototype,'fetch');
    await expect(deployTool(other,otherRun,plan)).rejects.toThrow('plan');
    expect(()=>validateHostArguments('secure_worker_deploy',{planId:plan.id,expectedRevision:1,workerName:'changed'})).toThrow();
    expect((await api(`/keychain/deploy-plans/${plan.id}`,'DELETE',{operationId:crypto.randomUUID(),expectedRevision:2})).status).toBe(409);
    expect((await api(`/keychain/deploy-plans/${plan.id}`,'DELETE',{operationId:crypto.randomUUID(),expectedRevision:1})).status).toBe(200);
    await expect(deployTool(b,run,plan)).rejects.toThrow('plan');expect(computer).not.toHaveBeenCalled();
  });
  it.each(['grant','replace','stop'])('CLI %s fences prevent capability/decryption dispatch',async action=>{
    const {b,run,refs,plan}=await deployFixture();
    if(action==='grant')await api(`/keychain/${refs[0].id}/permissions`,'POST',{botId:b.id,allowed:false});
    if(action==='replace')await save(b,payload({entries:[{id:refs[0].id,expectedRevision:1,value:'synthetic-only-new-cf-token'}]}));
    if(action==='stop')await api(`/bots/${b.id}/runs/${run.id}/cancel`,'POST');
    const computer=vi.spyOn(ComputerDO.prototype,'fetch'),decrypt=vi.spyOn(crypto.subtle,'decrypt');
    const result=await deployTool(b,run,plan);expect(result.status).not.toBe('completed');expect(computer).not.toHaveBeenCalled();expect(decrypt).not.toHaveBeenCalled();
  });
  it('recovers a lost CLI receipt as uncertain without a second provider call',async()=>{
    const {b,run,plan}=await deployFixture(),op=crypto.randomUUID(),computer=vi.spyOn(ComputerDO.prototype,'fetch');
    expect((await deployTool(b,run,plan,op)).status).toBe('failed');expect(computer).toHaveBeenCalledTimes(1);
    expect((await deployTool(b,run,plan,op)).status).toBe('failed');expect(computer).toHaveBeenCalledTimes(1);
    await runInDurableObject(owner(),(_i,state)=>state.storage.sql.exec("UPDATE secure_worker_deployments SET data=json_set(data,'$.state','dispatching') WHERE bot_id=? AND operation_id=?",b.id,op));
    await evictDurableObject(owner());
    expect((await deployTool(b,run,plan,op)).status).toBe('interrupted');expect(computer).toHaveBeenCalledTimes(1);
  });
  it.each(['revoke','envelope'])('metadata-only envelope verification fences first ref %s during the last awaited grant check',async action=>{
    const {b,run,refs,plan}=await deployFixture(true);
    await runInDurableObject(owner(),async(_i,state)=>{
      const chain=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});
      const authorization=await chain.secureWorkerDeployEnvelope({ownerId:'owner',botId:b.id,runId:run.id,nativeOperationId:crypto.randomUUID(),operationId:crypto.randomUUID(),planId:plan.id,planRevision:1,pin:{...plan.pin,planId:plan.id,planRevision:plan.revision},refs:refs.map(({id,revision})=>({id,revision})),expiresAt:Date.now()+55_000});
      const original=crypto.subtle.sign.bind(crypto.subtle);let calls=0;
      vi.spyOn(crypto.subtle,'sign').mockImplementation(async(...args)=>{
        const value=await original(...args);
        if(++calls===4){if(action==='revoke')chain.revoke(refs[0].id);else state.storage.sql.exec('UPDATE keychain_entries SET envelope=? WHERE id=?','{"iv":"synthetic-tamper","ciphertext":"synthetic-tamper"}',refs[0].id);}
        return value;
      });
      await expect(chain.assertSecureDeployEnvelopeCurrent(authorization)).rejects.toThrow('changed');
    });
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
  it('injects two permitted credentials with independent formats; validates every reference before dispatch and redacts variants',async()=>{
    const b=await bot();
    const saved=await save(b,payload({entries:[
      {name:'Fixture API key',origin:'https://api.example.com',header:'X-API-Key',prefix:'',value:'fixture-key-not-real-123'},
      {name:'Fixture account email',origin:'https://api.example.com',header:'X-Auth-Email',prefix:'',value:'fixture+mail@example.invalid'}
    ]}));
    const key=saved.find(entry=>entry.header==='X-API-Key')!,email=saved.find(entry=>entry.header==='X-Auth-Email')!;
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const sent=new Headers(init?.headers);expect(sent.get('x-api-key')).toBe('fixture-key-not-real-123');expect(sent.get('x-auth-email')).toBe('fixture+mail@example.invalid');
      return Response.json({echo:['fixture-key-not-real-123','fixture+mail@example.invalid'],encoded:btoa('fixture-key-not-real-123'),urlEncoded:'fixture%2bmail%40example.invalid',uppercaseHex:Array.from(new TextEncoder().encode('fixture-key-not-real-123'),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase(),key:'fixture-key-not-real-123',access_token:'service-issued-fixture-token'});
    });
    const args={secretId:key.id,additionalSecretIds:[email.id],path:'/account',headers:{'API-Version':'2026-01'}};
    const result=await useSecret(b,args);expect(result.status).toBe('completed');
    for(const secret of ['fixture-key-not-real-123','fixture+mail@example.invalid',btoa('fixture-key-not-real-123'),'fixture%2bmail%40example.invalid',Array.from(new TextEncoder().encode('fixture-key-not-real-123'),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase(),'service-issued-fixture-token'])expect(JSON.stringify(result)).not.toContain(secret);
    expect(transport).toHaveBeenCalledTimes(1);expect(await sqlDump(b)).not.toContain('fixture-key-not-real-123');expect(await sqlDump(b)).not.toContain('fixture+mail@example.invalid');
    const otherBot=await bot();const [unpermitted]=await save(otherBot,payload({entries:[{name:'Fixture third key',origin:'https://api.example.com',header:'X-Third-Key',prefix:'',value:'fixture-third-secret'}]}));
    await expect(useSecret(b,{secretId:key.id,additionalSecretIds:[unpermitted.id],path:'/'})).rejects.toThrow('permission');
    expect(transport).toHaveBeenCalledTimes(1);
    const [otherOrigin]=await save(b,payload({entries:[{name:'Other origin',origin:'https://other.example.com',header:'X-Other-Key',prefix:'',value:'fixture-other'}]}));
    const [sameHeaderDifferentCase]=await save(b,payload({entries:[{name:'Other header same case',origin:'https://api.example.com',header:'x-api-key',prefix:'',value:'fixture-other-header'}]}));
    expect([key.header,sameHeaderDifferentCase.header]).toEqual(['X-API-Key','x-api-key']);
    const invalidCases=[
      {secretId:key.id,additionalSecretIds:[key.id],path:'/'},
      {secretId:key.id,additionalSecretIds:[email.id],path:'/',headers:{'x-API-KEY':'public collision'}},
      {secretId:key.id,additionalSecretIds:[email.id],path:'/',headers:{'API-Version':'one','api-version':'two'}},
      {secretId:key.id,additionalSecretIds:[otherOrigin.id],path:'/'},
      {secretId:key.id,additionalSecretIds:[email.id,sameHeaderDifferentCase.id],path:'/'},
      {secretId:key.id,additionalSecretIds:[email.id,unpermitted.id,key.id],path:'/'}
    ];
    for(const [caseIndex,invalidArgs] of invalidCases.entries()) {
      try { const dispatched=await useSecret(b,invalidArgs);throw new Error(`Invalid composite case ${caseIndex} dispatched (${dispatched.status}).`); }
      catch(error) { if(error instanceof Error&&error.message.startsWith('Invalid composite case')) throw error; }
    }
    expect(transport).toHaveBeenCalledTimes(1);
    const op=crypto.randomUUID();await expect(runInDurableObject(owner(),(_i,state)=>new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{}).call(op,args,new AbortController().signal,()=>{
      const chain=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});chain.revoke(email.id);
    },b.id))).rejects.toThrow('revoked');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('dispatches the full four-reference composite limit',async()=>{
    const b=await bot(),saved=await save(b,payload({entries:[
      {name:'Four A',origin:'https://api.example.com',header:'X-Four-A',prefix:'',value:'fixture-four-a'},
      {name:'Four B',origin:'https://api.example.com',header:'X-Four-B',prefix:'',value:'fixture-four-b'},
      {name:'Four C',origin:'https://api.example.com',header:'X-Four-C',prefix:'',value:'fixture-four-c'},
      {name:'Four D',origin:'https://api.example.com',header:'X-Four-D',prefix:'',value:'fixture-four-d'}
    ]})),references=['X-Four-A','X-Four-B','X-Four-C','X-Four-D'].map(header=>saved.find(entry=>entry.header===header)!);
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const headers=new Headers(init?.headers);for(const [index,header] of ['X-Four-A','X-Four-B','X-Four-C','X-Four-D'].entries())expect(headers.get(header)).toBe(`fixture-four-${String.fromCharCode(97+index)}`);
      return Response.json({ok:true});
    });
    const result=await useSecret(b,{secretId:references[0].id,additionalSecretIds:references.slice(1).map(entry=>entry.id),path:'/four'});
    expect(result.status).toBe('completed');expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['revoke','replace','rename','regrant'] as const)('fences composite dispatch when %s races either reference after decryption',async action=>{
    for(const targetRole of ['primary','additional'] as const){
      const b=await bot(),saved=await save(b,payload({entries:[
        {name:'Private input',origin:'https://api.example.com',header:'X-Fence-A',prefix:'',value:'fixture-fence-first'},
        {name:'Private input',origin:'https://api.example.com',header:'X-Fence-B',prefix:'',value:'fixture-fence-second'}
      ]}));
      const primary=saved.find(entry=>entry.header==='X-Fence-A')!,additional=saved.find(entry=>entry.header==='X-Fence-B')!,target=targetRole==='primary'?primary:additional;
      const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({ok:true}));transport.mockClear();
      await expect(runInDurableObject(owner(),async(_i,state)=>{
        const chain=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{});
        return chain.call(crypto.randomUUID(),{secretId:primary.id,additionalSecretIds:[additional.id],path:'/'},new AbortController().signal,async()=>{
          if(action==='revoke')chain.revoke(target.id);
          else if(action==='replace')await chain.save({operationId:crypto.randomUUID(),entries:[{id:target.id,expectedRevision:target.revision,name:target.name,origin:target.origin,header:target.header,prefix:target.prefix,value:'fixture-fence-replaced'}]},()=>{});
          else if(action==='rename')await chain.rename(crypto.randomUUID(),target.id,{name:'Fenced rename',expectedRevision:target.revision},()=>{},b.id);
          else {state.storage.sql.exec('DELETE FROM keychain_grants WHERE secret_id=? AND bot_id=?',target.id,b.id);await chain.grantAccess(target.id,b.id,true);}
        },b.id);
      })).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
    }
  });
  it('rechecks task liveness after the awaited dispatch callback',async()=>{
    const b=await bot(),saved=await save(b,payload({entries:[
      {name:'Live first',origin:'https://api.example.com',header:'X-Live-A',prefix:'',value:'fixture-live-first'},
      {name:'Live second',origin:'https://api.example.com',header:'X-Live-B',prefix:'',value:'fixture-live-second'}
    ]})),primary=saved.find(entry=>entry.header==='X-Live-A')!,additional=saved.find(entry=>entry.header==='X-Live-B')!;
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({ok:true}));transport.mockClear();let live=true;
    await expect(runInDurableObject(owner(),async(_i,state)=>{
      const chain=new OwnerKeychain(state.storage,'owner',bindings.CHATGPT_CREDENTIAL_KEY,()=>{if(!live)throw new Error('Task stopped after callback');});
      return chain.call(crypto.randomUUID(),{secretId:primary.id,additionalSecretIds:[additional.id],path:'/'},new AbortController().signal,async()=>{live=false;},b.id);
    })).rejects.toThrow('Task stopped after callback');
    expect(transport).not.toHaveBeenCalled();
  });
  it('blocks, redacts and deduplicates composite redirects; changed retries conflict',async()=>{
    const b=await bot(),saved=await save(b,payload({entries:[
      {name:'Redirect first',origin:'https://api.example.com',header:'X-Redirect-A',prefix:'',value:'fixture-redirect-first'},
      {name:'Redirect second',origin:'https://api.example.com',header:'X-Redirect-B',prefix:'',value:'fixture-redirect-second'}
    ]})),primary=saved.find(entry=>entry.header==='X-Redirect-A')!,additional=saved.find(entry=>entry.header==='X-Redirect-B')!;
    const args={secretId:primary.id,additionalSecretIds:[additional.id],path:'/mutate',method:'POST',body:'{}'},op=crypto.randomUUID();
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('fixture-redirect-first fixture-redirect-second',{status:302,headers:{location:'https://evil.example.com'}}));
    const result=await useSecret(b,args,op);expect(result.status).toBe('failed');expect(JSON.stringify(result)).not.toContain('fixture-redirect');
    expect(await useSecret(b,args,op)).toEqual(result);expect(transport).toHaveBeenCalledTimes(1);
    await expect(useSecret(b,{...args,path:'/different'},op)).rejects.toThrow('changed');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('journals composite dispatch idempotently without values or automatic uncertain retry',async()=>{
    const b=await bot(),saved=await save(b,payload({entries:[
      {name:'Fixture A',origin:'https://api.example.com',header:'X-Key-A',prefix:'Key ',value:'fixture-composite-a'},
      {name:'Fixture B',origin:'https://api.example.com',header:'X-Key-B',prefix:'',value:'fixture-composite-b'}
    ]})),a=saved.find(entry=>entry.header==='X-Key-A')!,c=saved.find(entry=>entry.header==='X-Key-B')!;
    const args={secretId:a.id,additionalSecretIds:[c.id],path:'/mutate',method:'POST',body:'{}'},op=crypto.randomUUID();
    const transport=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('provider fixture failure'));
    const first=await useSecret(b,args,op);expect(first.status).toBe('interrupted');
    expect(await useSecret(b,args,op)).toEqual(first);expect(transport).toHaveBeenCalledTimes(1);
    const stored=await sqlDump(b);expect(stored).not.toContain('fixture-composite-a');expect(stored).not.toContain('fixture-composite-b');expect(stored).not.toContain('provider fixture failure');
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
  it.each(['list_secrets','name_secret'])('prevents a child run from obtaining named-bot keychain access through %s',async tool=>{
    const b=await bot(),{run}=await waiting(b);
    const result=await runInDurableObject(stub(b),async(instance,state)=>{
      const row=state.storage.sql.exec<{data:string;native_operation_id:string}>('SELECT data,native_operation_id FROM runs WHERE id=?',run.id).toArray()[0];state.storage.sql.exec('UPDATE runs SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),subagentId:'fixture-child'}),run.id);
      return (instance as unknown as {executeHostTool:(input:RuntimeHostToolRequest)=>Promise<RuntimeToolResult>}).executeHostTool({operationId:crypto.randomUUID(),runOperationId:row.native_operation_id,name:tool,arguments:tool==='name_secret'?{secretId:crypto.randomUUID(),name:'Fixture name',expectedRevision:1}:{},signal:new AbortController().signal});
    });expect(result.status).toBe('failed');expect(JSON.stringify(result)).toContain('Only the named bot');
  });
});
