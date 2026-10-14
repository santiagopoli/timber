#!/usr/bin/env node
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);

export async function requestProbe(url,token,fetcher=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),method='GET') {
  for(let attempt=0;attempt<6;attempt++) {
    const response=await fetcher(url,{method,headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(90_000)});
    if(response.ok)return response;
    await response.body?.cancel().catch(()=>{});
    if(![404,503].includes(response.status)||attempt===5)throw new Error(`probe_http_${response.status}`);
    await wait(2000);
  }
}

// Operational probe: the server owns OAuth and performs its normal catalogue
// read/serialized refresh. No credentials are fetched or exposed to this job.
async function main() {
  if(process.env.GITHUB_REF!=='refs/heads/main'||!/^\d+$/.test(process.env.GITHUB_RUN_ID||''))throw new Error('probe_requires_main_workflow');
  const dir=await mkdtemp(join(tmpdir(),'timber-catalog-probe-'));
  const name=`timber-model-probe-${process.env.GITHUB_RUN_ID}`;
  const token=randomBytes(32).toString('hex');
  const config=join(dir,'wrangler.json');
  const cli=async args=>exec('npx',['--yes','wrangler@4.147.0',...args,'--config',config],{timeout:180_000,maxBuffer:2_000_000});
  let attempted=false;
  try {
    await copyFile(new URL('./model-catalog-probe-worker.mjs',import.meta.url),join(dir,'worker.mjs'));
    await writeFile(config,JSON.stringify({name,main:'worker.mjs',account_id:'3acfff91febe1ba644c6358ae5612736',compatibility_date:'2026-10-05',workers_dev:true,
      vars:{PROBE_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')},
      durable_objects:{bindings:[{name:'CHATGPT',class_name:'ChatGPTAuthDO',script_name:'timber-api'},{name:'WORKSPACE',class_name:'WorkspaceDO',script_name:'timber-api'},{name:'BOT',class_name:'BotDO',script_name:'timber-api'}]}}));
    attempted=true;
    const result=await cli(['deploy']);
    const url=result.stdout.match(new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev\\b`))?.[0];
    if(!url)throw new Error('probe_endpoint_unavailable');
    const response=await requestProbe(`${url}/catalog`,token);
    const value=await response.json();
    // Reconstruct only the already sanitized shape before writing to CI logs.
    if(typeof value.connected!=='boolean'||!Number.isSafeInteger(value.models)||value.models<0||typeof value.connection!=='string'||!/^\w{1,64}$/.test(value.connection)||value.failure!==null&&!/^\w{1,64}$/.test(value.failure))throw new Error('probe_invalid_projection');
    console.log(JSON.stringify({connection:value.connection,connected:value.connected,models:value.models,failure:value.failure,
      ...(value.cached===true?{cached:true}:{}),
      ...(Number.isInteger(value.upstreamStatus)&&value.upstreamStatus>=100&&value.upstreamStatus<=599?{upstreamStatus:value.upstreamStatus}:{})}));
    const queue=await (await requestProbe(`${url}/queue`,token)).json();
    if(!Array.isArray(queue.bots)||queue.bots.length>20)throw new Error('probe_invalid_projection');
    console.log(JSON.stringify(queue));
    const transport=await (await requestProbe(`${url}/transport`,token)).json();
    console.log(JSON.stringify(transport));
    if(process.env.COMPARE_MODEL_AUTHENTICATION==='1'||process.env.RENEW_MODEL_CREDENTIALS==='1'){
      const comparison=await (await requestProbe(`${url}/${process.env.RENEW_MODEL_CREDENTIALS==='1'?'renew-authentication':'authentication'}`,token,fetch,undefined,'POST')).json();
      console.log(JSON.stringify({authenticationComparison:comparison}));
    }
    if(process.env.VERIFY_MODEL_INFERENCE==='1'){
      const verification=await (await requestProbe(`${url}/verify`,token,fetch,undefined,'POST')).json();
      console.log(JSON.stringify({verifiedInference:verification.ok===true,status:verification.status,failure:verification.failure}));
    }
  } finally {
    try {if(attempted)await cli(['delete','--force']);}
    catch {console.error(JSON.stringify({error:'probe_cleanup_failed',worker:name}));process.exitCode=1;}
    await rm(dir,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(JSON.stringify({error:/^probe_[a-z0-9_]+$/.test(error?.message||'')?error.message:'probe_failed'}));process.exitCode=1;});
