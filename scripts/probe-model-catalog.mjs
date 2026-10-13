#!/usr/bin/env node
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

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
      durable_objects:{bindings:[{name:'CHATGPT',class_name:'ChatGPTAuthDO',script_name:'timber-api'}]}}));
    attempted=true;
    const result=await cli(['deploy']);
    const url=result.stdout.match(new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev\\b`))?.[0];
    if(!url)throw new Error('probe_endpoint_unavailable');
    const response=await fetch(`${url}/catalog`,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(60_000)});
    if(!response.ok)throw new Error(`probe_http_${response.status}`);
    const value=await response.json();
    // Reconstruct only the already sanitized shape before writing to CI logs.
    if(typeof value.connected!=='boolean'||!Number.isSafeInteger(value.models)||value.models<0||typeof value.connection!=='string'||!/^\w{1,64}$/.test(value.connection)||value.failure!==null&&!/^\w{1,64}$/.test(value.failure))throw new Error('probe_invalid_projection');
    console.log(JSON.stringify({connection:value.connection,connected:value.connected,models:value.models,failure:value.failure}));
  } finally {
    try {if(attempted)await cli(['delete','--force']);}
    catch {console.error(JSON.stringify({error:'probe_cleanup_failed',worker:name}));process.exitCode=1;}
    await rm(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(JSON.stringify({error:/^probe_[a-z0-9_]+$/.test(error?.message||'')?error.message:'probe_failed'}));process.exitCode=1;});
