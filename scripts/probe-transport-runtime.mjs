import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

// Isolated provisioning test. These namespaces never bind the credential owner
// or a bot; the only upstream credential is a fixed deliberately invalid value.
async function main(){
  if(process.env.GITHUB_REF!=='refs/heads/main'||!/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw new Error('runtime_probe_requires_main');
  const dir=await mkdtemp(join(tmpdir(),'timber-transport-runtime-'));
  const name=`timber-transport-test-${process.env.GITHUB_RUN_ID}`;
  const token=randomBytes(32).toString('hex');
  const config=join(dir,'wrangler.json');
  const image='registry.cloudflare.com/3acfff91febe1ba644c6358ae5612736/timber-computer@sha256:47ad585557cea558179799bb290dcef78ec25998efeb4c962d26de4f089790d9';
  const cli=args=>execute('npx',['--yes','wrangler@4.147.0',...args,'--config',config],{timeout:180_000,maxBuffer:2_000_000});
  let url,attempted=false;
  try{
    let source=await readFile(new URL('../apps/api/src/chatgpt-transport.ts',import.meta.url),'utf8');
    source=source.replace("import {ApiError, errorResponse} from './errors';",`class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}\nconst errorResponse=(error:ApiError)=>Response.json({error:{code:error.code}},{status:error.status});`)
      .replace("import type {Env} from './env';",'interface Env {}');
    const standard=source.replace(/ChatGPTTransportDO/g,'StandardTransportDO').replace("instance: 'lite'","instance: 'standard-1'");
    await writeFile(join(dir,'lite.ts'),source);await writeFile(join(dir,'standard.ts'),standard);
    await writeFile(join(dir,'worker.ts'),`import {ChatGPTTransportDO} from './lite';
import {StandardTransportDO} from './standard';
export class LiteProbe extends ChatGPTTransportDO {async inspectProbe(){return {running:this.ctx.container?.running===true,imageKnown:Boolean(this.ctx.container?.images.base)};} async stopProbe(){await this.ctx.container?.destroy();}}
export class StandardProbe extends StandardTransportDO {async inspectProbe(){return {running:this.ctx.container?.running===true,imageKnown:Boolean(this.ctx.container?.images.base)};} async stopProbe(){await this.ctx.container?.destroy();}}
export default {async fetch(request:Request,env:any){
 const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 if(!token)return new Response(null,{status:401});
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
 const path=new URL(request.url).pathname;
 if(path==='/stop'&&request.method==='POST'){for(const key of ['LITE','STANDARD'])await env[key].get(env[key].idFromName('probe')).stopProbe();return Response.json({stopped:true});}
 if(path!=='/compare'||request.method!=='GET')return new Response(null,{status:404});
 const results=[];
 for(const key of ['LITE','STANDARD']){
  const stub=env[key].get(env[key].idFromName('probe'));let result:any={instance:key==='LITE'?'lite':'standard-1'};
  try{const response=await stub.fetch('https://transport/v1/models',{headers:{'x-timber-internal':'chatgpt-transport',authorization:'Bearer invalid-diagnostic-token'},signal:AbortSignal.timeout(50_000)});result.status=response.status;await response.body?.cancel();}catch{result.failure='transport_unavailable';}
  try{const state=await stub.inspectProbe();result.running=state.running===true;result.imageKnown=state.imageKnown===true;}catch{result.inspectionFailed=true;}
  results.push(result);
 }
 return Response.json({runtimeComparison:results});
}};`);
    await writeFile(config,JSON.stringify({name,main:'worker.ts',account_id:'3acfff91febe1ba644c6358ae5612736',compatibility_date:'2026-10-05',workers_dev:true,
      vars:{PROBE_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')},
      durable_objects:{bindings:[{name:'LITE',class_name:'LiteProbe'},{name:'STANDARD',class_name:'StandardProbe'}]},
      migrations:[{tag:'v1',new_sqlite_classes:['LiteProbe','StandardProbe']}],
      containers:['LiteProbe','StandardProbe'].map(class_name=>({class_name,scheduling_policy:'durable_object',images:{base:{image}}}))}));
    attempted=true;
    const result=await cli(['deploy']);
    url=result.stdout.match(new RegExp('https://'+name+'\\.[a-z0-9-]+\\.workers\\.dev\\b'))?.[0];
    if(!url)throw new Error('runtime_probe_url_unavailable');
    let response;
    for(let attempt=0;attempt<6;attempt++){
      response=await fetch(url+'/compare',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(150_000)});
      if(response.status!==404)break;await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,2000));
    }
    if(!response.ok)throw new Error('runtime_probe_failed');
    const value=await response.json();
    const comparison=(Array.isArray(value.runtimeComparison)?value.runtimeComparison:[]).slice(0,2).map(item=>({
      instance:['lite','standard-1'].includes(item.instance)?item.instance:'unknown',
      ...(Number.isInteger(item.status)&&item.status>=100&&item.status<=599?{status:item.status}:{}),
      running:item.running===true,imageKnown:item.imageKnown===true,
      ...(item.failure?{failure:'transport_unavailable'}:{}),
    }));
    console.log(JSON.stringify({runtimeComparison:comparison}));
  }finally{
    if(url)try{const response=await fetch(url+'/stop',{method:'POST',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(30_000)});await response.body?.cancel();}catch{}
    if(attempted)try{await cli(['delete','--force']);}catch{console.error('runtime_probe_cleanup_failed');process.exitCode=1;}
    await rm(dir,{recursive:true,force:true});
  }
}
main().catch(()=>{console.error('runtime_probe_failed');process.exitCode=1;});
