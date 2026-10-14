import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,lstat,chmod,symlink,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {webcrypto} from 'node:crypto';
import {credentialStore,newDeviceKey,secureDirectory} from '../../packages/runner/src/credentials.mjs';
import {Files,workspace} from '../../packages/runner/src/workspaces.mjs';
import {DeviceClient} from '../../packages/runner/src/device-client.mjs';
import {deviceProofMessage,deviceDecodeBase64Url} from '../../packages/contracts/src/devices.ts';
import {diagnostics} from '../../packages/runner/src/diagnostics.mjs';
async function temporary(work){const dir=await mkdtemp(join(tmpdir(),'timber-runner-security-'));try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('Linux signing keys are private, nonextractable after loading, and reject symlink or loose-mode storage',async()=>temporary(async dir=>{
 const keys=await newDeviceKey(),store=credentialStore(dir,{platform:'linux'});await store.save('fixture-key',keys.privateKey);
 assert.equal((await lstat(dir)).mode&0o777,0o700);assert.equal((await lstat(join(dir,'key-fixture-key.pk8'))).mode&0o777,0o600);
 const loaded=await store.load('fixture-key');assert.equal(loaded.extractable,false);const signature=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},loaded,new TextEncoder().encode('device proof'));
 const publicKey=await webcrypto.subtle.importKey('jwk',keys.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,signature,new TextEncoder().encode('device proof')),true);
 await chmod(join(dir,'key-fixture-key.pk8'),0o644);await assert.rejects(store.load('fixture-key'),{code:'unsafe_credential_file'});
 await symlink(join(dir,'key-fixture-key.pk8'),join(dir,'key-link.pk8'));await assert.rejects(store.load('link'),{code:'unsafe_credential_file'});
}));
test('macOS writes a private key to Keychain through stdin, never process arguments',async()=>temporary(async dir=>{
 const calls=[],keys=await newDeviceKey();const spawnProcess=(file,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();let input='';child.stdin.on('data',chunk=>{input+=chunk.toString();});child.stdin.on('finish',()=>{calls.push({file,args,input});queueMicrotask(()=>child.emit('close',0));});return child;};
 await credentialStore(dir,{platform:'darwin',spawnProcess}).save('fixture-key',keys.privateKey);
 assert.equal(calls[0].file,'/usr/bin/security');assert.deepEqual(calls[0].args,['-i']);assert.match(calls[0].input,/add-generic-password/);assert.match(calls[0].input,/-w '[A-Za-z0-9+/=]+'/);assert.equal(JSON.stringify(calls[0].args).includes('generic-password'),false);
 assert.equal(await readFile(join(dir,'key-fixture-key.pk8')).then(()=>true,()=>false),false);
}));
test('signed HTTPS binds exact route, method, device, nonce and body without exposing credentials',async()=>{
 const keys=await newDeviceKey(),calls=[];const client=new DeviceClient({url:'https://timber.example',id:'fixture-device',privateKey:keys.privateKey,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({ok:true});}});
 await client.request('/v1/device-connect/fixture-device/jobs/poll',{fixture:'hello'});const {options,url}=calls[0];assert.equal(url,'https://timber.example/v1/device-connect/fixture-device/jobs/poll');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,undefined);
 const h=options.headers,message=await deviceProofMessage({method:'POST',path:'/v1/device-connect/fixture-device/jobs/poll',id:h['x-timber-device'],time:h['x-timber-time'],nonce:h['x-timber-nonce'],body:options.body});const publicKey=await webcrypto.subtle.importKey('jwk',keys.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 assert.equal(await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,deviceDecodeBase64Url(h['x-timber-signature']),new TextEncoder().encode(message)),true);
 assert.equal(JSON.stringify(calls).includes('"d"'),false);assert.throws(()=>new DeviceClient({url:'http://timber.example',id:'device',privateKey:keys.privateKey}),{code:'invalid_endpoint'});assert.throws(()=>new DeviceClient({url:'https://owner-secret@timber.example',id:'device',privateKey:keys.privateKey}),{code:'invalid_endpoint'});
});
test('workspace reads and writes reject traversal, symlinks and runner credential storage',async()=>temporary(async dir=>{
 const project=join(dir,'project'),state=join(project,'.runner'),outside=join(dir,'outside');await mkdir(project);await secureDirectory(state);await mkdir(outside);await writeFile(join(outside,'private.txt'),'outside-private-content');await writeFile(join(state,'private.txt'),'runner-private-content');
 const files=new Files([await workspace(project)],{protectedRoots:[state]});await files.write('workspace','nested/file.txt','inside');assert.equal(await files.read('workspace','nested/file.txt'),'inside');assert.equal((await lstat(join(project,'nested/file.txt'))).mode&0o777,0o600);
 await symlink(outside,join(project,'shortcut'));await symlink(join(outside,'private.txt'),join(project,'file-link'));
 for(const path of ['../outside/private.txt','shortcut/private.txt','file-link','.runner/private.txt']){await assert.rejects(files.read('workspace',path));await assert.rejects(files.write('workspace',path,'overwrite'));}
 assert.equal(await readFile(join(outside,'private.txt'),'utf8'),'outside-private-content');assert.equal(await readFile(join(state,'private.txt'),'utf8'),'runner-private-content');
}));
test('typed diagnostics exclude process arguments, environment and Keychain values',async()=>temporary(async dir=>{
 const files=new Files([await workspace(dir)]),system=await diagnostics({target:'system'},files,'workspace');assert.ok(system.cpuCount>0);assert.ok(system.totalMemoryBytes>0);assert.equal(system.env,undefined);
 const processes=await diagnostics({target:'processes',limit:5},files,'workspace');assert.ok(processes.length<=5);for(const item of processes)assert.deepEqual(Object.keys(item).sort(),['cpuPercent','name','pid','residentMemoryBytes'].sort());
 const disk=await diagnostics({target:'disk'},files,'workspace');assert.ok(disk.totalBytes>0);assert.equal(disk.files,undefined);
}));
test('replacing a registered workspace root with a symlink cannot redirect directory reads',async()=>temporary(async dir=>{
 const project=join(dir,'project'),outside=join(dir,'outside');await mkdir(project);await mkdir(outside);const files=new Files([await workspace(project)]);await rm(project,{recursive:true});await symlink(outside,project);await assert.rejects(files.list('workspace','.'),{code:'workspace_escape'});
}));
