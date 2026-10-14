import {mkdir,open,lstat,chmod,unlink,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {webcrypto,randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {RunnerError} from './errors.mjs';
const service='com.timber.runner';
const idPattern=/^[A-Za-z0-9-]{1,80}$/;
export async function secureDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw new RunnerError('unsafe_state_directory','Runner state must be an owned directory, without symlinks.');
 await chmod(path,0o700);
}
export async function writePrivateFile(path,bytes){
 const existing=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(existing&&(existing.isSymbolicLink()||!existing.isFile()||existing.nlink>1||process.getuid&&existing.uid!==process.getuid()))throw new RunnerError('unsafe_credential_file','Credential storage must be an owned regular file without links.');
 const temporary=join(dirname(path),`.timber-private-${randomUUID()}`),file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try {await file.writeFile(bytes);await file.sync();await rename(temporary,path);const directory=await open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}finally{await file.close();await unlink(temporary).catch(()=>{});}
}
async function security(args,input,spawnProcess=spawn){
 return new Promise((resolve,reject)=>{const child=spawnProcess('/usr/bin/security',args,{stdio:['pipe','pipe','pipe']});let output='',overflow=false;
  child.stdout.on('data',chunk=>{if(output.length+chunk.length<=16384)output+=chunk.toString();else{overflow=true;child.kill();}});child.stderr.on('data',()=>{});
  child.on('error',()=>reject(new RunnerError('keychain_unavailable','macOS Keychain could not be opened.')));child.on('close',code=>code===0&&!overflow?resolve(output.trim()):reject(new RunnerError('keychain_unavailable','macOS Keychain did not complete the credential request.')));child.stdin.end(input??'');
 });
}
export function credentialStore(stateDir,{platform=process.platform,spawnProcess=spawn}={}){
 const validate=id=>{if(!idPattern.test(id))throw new RunnerError('invalid_key_id','Invalid device key identity.');};
 return {
  async save(id,key){validate(id);await secureDirectory(stateDir);const raw=Buffer.from(await webcrypto.subtle.exportKey('pkcs8',key));
   if(platform==='darwin')await security(['-i'],`add-generic-password -U -a '${id}' -s '${service}' -w '${raw.toString('base64')}'\n`,spawnProcess);
   else if(platform==='linux')await writePrivateFile(join(stateDir,`key-${id}.pk8`),raw);
   else throw new RunnerError('unsupported_platform','The runner supports macOS and Linux.');
  },
  async load(id){validate(id);let raw;
   if(platform==='darwin')raw=Buffer.from(await security(['find-generic-password','-a',id,'-s',service,'-w'],undefined,spawnProcess),'base64');
   else if(platform==='linux'){const path=join(stateDir,`key-${id}.pk8`),stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new RunnerError('unsafe_credential_file','Device private keys require an owned file with mode 0600.');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{raw=await file.readFile();}finally{await file.close();}}
   else throw new RunnerError('unsupported_platform','The runner supports macOS and Linux.');
   return webcrypto.subtle.importKey('pkcs8',raw,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  },
  async remove(id){validate(id);if(platform==='darwin')await security(['delete-generic-password','-a',id,'-s',service],undefined,spawnProcess);else await unlink(join(stateDir,`key-${id}.pk8`)).catch(error=>{if(error.code!=='ENOENT')throw error;});},
 };
}
export async function newDeviceKey(){const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return {privateKey:keys.privateKey,publicKey:await webcrypto.subtle.exportKey('jwk',keys.publicKey)};}
