import {spawn} from 'node:child_process';
import {open,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
let shell,cancelled=false,stopping=false,deadline;
let start,output='';
const report=data=>{if(process.connected)process.send(data);};
function cancel(){if(stopping||!shell)return;stopping=true;cancelled=true;try{process.kill(-shell.pid,'SIGTERM');}catch{}const force=setTimeout(()=>{try{process.kill(-shell.pid,'SIGKILL');}catch{}},1500);force.unref();}
process.on('message',message=>{
 if(message?.type==='cancel'){cancel();return;}
 if(message?.type!=='start'||shell)return;
 start=message;
 shell=spawn(message.shell??'/bin/sh',['-c',message.command],{cwd:message.cwd,detached:true,stdio:['ignore','pipe','pipe']});
 shell.once('spawn',()=>report({type:'started'}));
 for(const stream of [shell.stdout,shell.stderr])stream.on('data',chunk=>{
  output=(output+chunk.toString('utf8')).slice(-65536);
  if(!process.connected)return;stream.pause();process.send({type:'output',data:chunk.subarray(0,65536).toString('utf8')},()=>stream.resume());
 });
 shell.once('error',()=>{stopping=true;report({type:'failed'});process.exitCode=1;if(process.connected)process.disconnect();});
 shell.once('close',async(code,signal)=>{
  stopping=true;clearTimeout(deadline);const receipt={processId:start.processId,jobId:start.jobId,status:cancelled?'cancelled':code===0?'completed':'failed',exitCode:code,cancelled,output};
  try{const temporary=`${start.receiptPath}.${process.pid}.tmp`,file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(JSON.stringify(receipt));await file.sync();}finally{await file.close();}await rename(temporary,start.receiptPath);const directory=await open(dirname(start.receiptPath),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}catch{}
  report({type:'exited',code,signal,cancelled});if(process.connected)process.disconnect();
 });
 if(message.timeoutMs)deadline=setTimeout(cancel,message.timeoutMs);
});
// Losing the runner's IPC channel cancels the process group. No orphan process
// is rediscovered by PID or automatically relaunched after a runner crash.
process.on('disconnect',cancel);process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
