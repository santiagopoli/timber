import {realpath,lstat,readdir,mkdir,open,rename,unlink,statfs} from 'node:fs/promises';
import {constants,realpathSync} from 'node:fs';
import {resolve,relative,dirname,join,sep,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunnerError} from './errors.mjs';
export function contains(root,path){const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith(`..${sep}`)&&!rel.startsWith(sep);}
export async function workspace(path,id='workspace'){
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new RunnerError('invalid_workspace','Workspace IDs use letters, digits, underscores or hyphens.');
 const absolute=await realpath(resolve(path)),stat=await lstat(absolute);if(!stat.isDirectory())throw new RunnerError('invalid_workspace','A workspace must be an existing directory.');return {id,name:absolute.split(sep).at(-1)||id,path:absolute};
}
export class Files {
 constructor(workspaces,{protectedRoots=[]}={}){this.workspaces=new Map(workspaces.map(item=>[item.id,item]));this.protectedRoots=protectedRoots.map(root=>{try{return realpathSync(root);}catch{return resolve(root);}});}
 root(id){const value=this.workspaces.get(id);if(!value)throw new RunnerError('workspace_not_allowed','This workspace is not advertised by this runner.');return value.path;}
 path(id,path='.'){
  if(typeof path!=='string'||path.includes('\0')||path.length>4096)throw new RunnerError('invalid_path','Invalid workspace path.');
  const root=this.root(id),physical=isAbsolute(path)&&contains(root,resolve(path)),candidate=resolve(root,physical?path:path==='/workspace'?'.':path.startsWith('/workspace/')?path.slice(11):path);
  if(!contains(root,candidate)||this.protectedRoots.some(protectedRoot=>contains(protectedRoot,candidate)))throw new RunnerError('workspace_escape','This path is outside the allowed workspace or belongs to protected runner storage.');return candidate;
 }
 async safe(id,path='.',{parents=false}={}){
  const root=this.root(id),candidate=this.path(id,path),parts=relative(root,candidate).split(sep).filter(Boolean);let current=root;
  const base=await lstat(root);if(base.isSymbolicLink()||!base.isDirectory()||await realpath(root)!==root)throw new RunnerError('workspace_escape','The registered workspace directory changed or became a symlink.');
  for(let index=0;index<parts.length;index++){
   current=join(current,parts[index]);let stat;
   try{stat=await lstat(current);}catch(error){if(error.code==='ENOENT'&&parents&&index<parts.length-1){await mkdir(current,{mode:0o700});stat=await lstat(current);}else if(error.code==='ENOENT'&&parents&&index===parts.length-1)return candidate;else throw new RunnerError('file_unavailable','The requested workspace path is unavailable.');}
   if(stat.isSymbolicLink())throw new RunnerError('workspace_escape','Workspace file tools do not follow symlinks.');
   const canonical=await realpath(current);if(!contains(root,canonical)||this.protectedRoots.some(protectedRoot=>contains(protectedRoot,canonical)))throw new RunnerError('workspace_escape','This path escapes the allowed workspace.');
  }
  return candidate;
 }
 async read(id,path){
  const candidate=await this.safe(id,path),file=await open(candidate,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const fd=await file.stat(),actual=await lstat(await this.safe(id,path));if(!fd.isFile()||fd.dev!==actual.dev||fd.ino!==actual.ino)throw new RunnerError('file_unavailable','The file changed before it could be read.');
   const bytes=Buffer.alloc(Math.min(fd.size,65536)),{bytesRead}=await file.read(bytes,0,bytes.length,0);return `${fd.size>bytes.length?'[File truncated to 65536 bytes]\n':''}${bytes.subarray(0,bytesRead).toString('utf8')}`;
  }finally{await file.close();}
 }
 async list(id,path='.') {const candidate=await this.safe(id,path),entries=await readdir(candidate,{withFileTypes:true});return JSON.stringify(entries.slice(0,200).map(item=>({name:item.name,type:item.isSymbolicLink()?'symlink':item.isDirectory()?'directory':'file'})));}
 async write(id,path,content){
  if(typeof content!=='string'||Buffer.byteLength(content)>1048576)throw new RunnerError('invalid_file','File content must be text of at most 1 MiB.');
  const candidate=await this.safe(id,path,{parents:true}),parent=dirname(candidate),temporary=join(parent,`.timber-write-${randomUUID()}`);
  const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try {const fd=await file.stat(),current=await lstat(await this.safe(id,temporary));if(fd.dev!==current.dev||fd.ino!==current.ino)throw new RunnerError('workspace_escape','The workspace directory changed before writing.');await file.writeFile(content);await file.sync();await this.safe(id,path,{parents:true});await rename(temporary,candidate);const directory=await open(parent,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}finally{await file.close();await unlink(temporary).catch(()=>{});}
  return 'File written and synced to the local filesystem.';
 }
 async disk(id){const stat=await statfs(this.root(id));return {totalBytes:Number(stat.blocks)*Number(stat.bsize),availableBytes:Number(stat.bavail)*Number(stat.bsize),freeBytes:Number(stat.bfree)*Number(stat.bsize)};}
}
