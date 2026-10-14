import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {main} from '../../packages/runner/src/cli.mjs';
import {control,serveControl} from '../../packages/runner/src/control.mjs';
import {secureDirectory} from '../../packages/runner/src/credentials.mjs';
const fixtureUrl='https://timber-fixture.example';
test('connect, run, status and disconnect use device proofs without owner tokens or private key output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'timber-runner-cli-')),state=join(dir,'.runner'),deviceId=randomUUID(),pairingId=randomUUID(),logs=[],requests=[];const originalFetch=globalThis.fetch,originalLog=console.log;let polls=0,publicKey;
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);requests.push({path,body,headers:options.headers});
  if(path==='/v1/device-connect/pairings'){publicKey=body.publicKey;return Response.json({pairingId,code:'FIXTURE-PAIR',expiresAt:new Date(Date.now()+60000).toISOString()});}
  assert.ok(options.headers['x-timber-signature']);assert.equal(options.headers.authorization,undefined);
  if(path.endsWith('/poll')&&path.includes('/pairings/'))return Response.json({status:'approved',deviceId});
  if(path.endsWith('/heartbeat'))return Response.json({device:{id:deviceId}});
  if(path.endsWith('/jobs/poll')){polls++;setTimeout(()=>process.emit('SIGINT'),10);return Response.json({jobs:[],cancellations:[],device:{id:deviceId,status:'online',grants:[]}});}
  if(path.endsWith('/disconnect'))return Response.json({revoked:true});throw new Error('Unexpected fixture route');
 };console.log=(...args)=>logs.push(args.join(' '));
 try{
  await main(['connect','--url',fixtureUrl,'--workspace',dir,'--grant','diagnostics,files.read,agent.run','--state-dir',state]);assert.equal(polls,1);assert.equal(publicKey.d,undefined);
  const config=JSON.parse(await readFile(join(state,'config.json'),'utf8')),privateBytes=await readFile(join(state,`key-${config.keyId}.pk8`));assert.equal((await lstat(join(state,'config.json'))).mode&0o777,0o600);assert.equal(logs.join('\n').includes(privateBytes.toString('base64')),false);assert.ok(logs.some(line=>line.includes('FIXTURE-PAIR')));
  await main(['status','--state-dir',state]);assert.equal(JSON.parse(logs.at(-1)).running,false);await main(['run','--state-dir',state]);assert.equal(polls,2);
  await main(['disconnect','--state-dir',state]);assert.equal(JSON.parse(await readFile(join(state,'config.json'),'utf8')).disconnected,true);assert.equal(await readFile(join(state,`key-${config.keyId}.pk8`)).then(()=>true,()=>false),false);assert.ok(logs.at(-1).includes('revoked'));
  assert.equal(requests.some(request=>request.headers.authorization),false);assert.equal(requests.some(request=>request.path.includes('owner')),false);
 }finally{globalThis.fetch=originalFetch;console.log=originalLog;await rm(dir,{recursive:true,force:true});}
});
test('private Unix control socket reports status and stops only its local runner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'timber-runner-control-'));await secureDirectory(dir);let stopped=false;const close=await serveControl(dir,{status:()=>({running:true,processes:1}),stop:()=>{stopped=true;}});
 try{assert.equal((await lstat(join(dir,'runner.sock'))).mode&0o777,0o600);assert.deepEqual(await control(dir,'status'),{running:true,processes:1});assert.deepEqual(await control(dir,'stop'),{stopping:true});assert.equal(stopped,true);}finally{await close();await rm(dir,{recursive:true,force:true});}
});
test('the packaged npm bin executes through its symlink and reports help without starting a worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'timber-runner-bin-')),bin=join(dir,'timber-runner');await symlink(new URL('../../packages/runner/dist/cli.mjs',import.meta.url).pathname,bin);
 try{const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[bin,'help','--state-dir',join(dir,'state')],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});child.on('error',reject);child.on('exit',code=>resolve({code,output,errors}));});assert.equal(result.code,0,result.errors);assert.match(result.output,/timber-runner connect/);assert.match(result.output,/host\.shell/);}finally{await rm(dir,{recursive:true,force:true});}
});
