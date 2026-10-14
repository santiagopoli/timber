import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,openSync,closeSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {RunnerError} from './errors.mjs';
export const OUTPUT_LIMIT=65536;
export function boundedOutput(text,limit=OUTPUT_LIMIT){const bytes=Buffer.from(String(text));return bytes.length<=limit?String(text):`[Earlier output truncated]\n${bytes.subarray(bytes.length-limit).toString('utf8')}`;}
export class Journal {
 constructor(stateDir){
  this.path=join(stateDir,'journal.sqlite');
  if(existsSync(this.path)){const stat=lstatSync(this.path);if(!stat.isFile()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw new RunnerError('unsafe_journal','The effect journal must be an owned regular file.');}
  else closeSync(openSync(this.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600));
  chmodSync(this.path,0o600);this.db=new DatabaseSync(this.path);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,operation_key TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,result TEXT,reported INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS processes(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',exit_code INTEGER,cancelled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS agent_events(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,event TEXT NOT NULL,reported INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,sequence));
   CREATE TABLE IF NOT EXISTS fenced_job_events(job_id TEXT PRIMARY KEY);
   CREATE INDEX IF NOT EXISTS jobs_outbox ON jobs(reported,state);
   CREATE INDEX IF NOT EXISTS processes_state ON processes(state);
   CREATE INDEX IF NOT EXISTS events_outbox ON agent_events(reported,job_id,sequence);`);
 }
 receive(job){
  const operationKey=JSON.stringify([job.deviceId,job.botId,job.scopeId??job.taskId??job.botId,job.workspaceId,job.operationId,job.type]);
  const fingerprint=createHash('sha256').update(JSON.stringify({operationKey,type:job.type,permission:job.permission,action:job.action,agent:job.agent})).digest('hex');
  const prior=this.db.prepare('SELECT * FROM jobs WHERE id=? OR operation_key=?').get(job.id,operationKey);
  if(prior){if(prior.fingerprint!==fingerprint||prior.id!==job.id)throw new RunnerError('operation_conflict','This operation already belongs to another job or action.');return this.job(prior.id);}
  this.db.prepare("INSERT INTO jobs(id,operation_key,fingerprint,body,state) VALUES(?,?,?,?,'accepted')").run(job.id,operationKey,fingerprint,JSON.stringify(job));return this.job(job.id);
 }
 job(id){const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);return row?{...row,job:JSON.parse(row.body),result:row.result?JSON.parse(row.result):undefined}:undefined;}
 state(id,state){this.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,id);}
 finish(id,result){this.db.prepare("UPDATE jobs SET state='settled',result=?,reported=0 WHERE id=?").run(JSON.stringify(result),id);}
 pending(){return this.db.prepare("SELECT id FROM jobs WHERE state IN ('accepted','executing') ORDER BY rowid").all().map(row=>this.job(row.id));}
 recover(){
  // 'executing' was fsynced before dispatch; without a receipt its outcome is
  // unknown. Even a repeat delivery cannot authorize another unsafe effect.
  for(const row of this.db.prepare("SELECT id,body FROM jobs WHERE state='executing'").all()){
   const job=JSON.parse(row.body);this.finish(row.id,job.type==='agent'?{agentResult:{status:'unanswered',reason:'runner_restarted',text:'The local agent was interrupted by runner restart. Recorded effects are preserved; start an explicit continuation.'}}:{result:{operationId:job.operationId,status:'interrupted',...(job.action?.type==='exec'?{processKnown:false,processId:`device-process:${job.id}`}:{ }),error:'Runner restarted without a confirmed effect receipt. Inspect the machine before requesting a new action.'}});
  }
  this.db.prepare("UPDATE processes SET state='interrupted' WHERE state='running'").run();
 }
 outbox(){return this.db.prepare("SELECT id FROM jobs WHERE state='settled' AND reported=0 ORDER BY rowid LIMIT 32").all().map(row=>this.job(row.id));}
 reported(id){this.db.prepare('UPDATE jobs SET reported=1 WHERE id=?').run(id);}
 process(id){return this.db.prepare('SELECT * FROM processes WHERE id=?').get(id);}
 processesPending(){return this.db.prepare("SELECT * FROM processes WHERE state IN ('running','interrupted') LIMIT 32").all();}
 startProcess(id,jobId){this.db.prepare("INSERT INTO processes(id,job_id,state) VALUES(?,?,'running')").run(id,jobId);}
 output(id,text){this.db.prepare('UPDATE processes SET output=? WHERE id=?').run(boundedOutput(text),id);}
 endProcess(id,state,exitCode,cancelled=false){this.db.prepare('UPDATE processes SET state=?,exit_code=?,cancelled=? WHERE id=?').run(state,exitCode??null,cancelled?1:0,id);}
 event(jobId,event){
  const last=this.db.prepare('SELECT sequence,event,reported FROM agent_events WHERE job_id=? ORDER BY sequence DESC LIMIT 1').get(jobId),previous=last?JSON.parse(last.event):undefined;
  if(last?.reported===0&&event.type==='message.delta'&&previous.type==='message.delta'&&event.operationId===previous.operationId&&typeof event.data?.delta==='string'&&Buffer.byteLength(previous.data.delta+event.data.delta)<=65536){previous.data.delta+=event.data.delta;this.db.prepare('UPDATE agent_events SET event=? WHERE job_id=? AND sequence=?').run(JSON.stringify(previous),jobId,last.sequence);return last.sequence;}
  const seq=(last?.sequence??0)+1,stable={...event,eventKey:event.eventKey??`device-event:${jobId}:${seq}`},fenced=Boolean(this.db.prepare('SELECT 1 FROM fenced_job_events WHERE job_id=?').get(jobId));this.db.prepare('INSERT INTO agent_events(job_id,sequence,event,reported) VALUES(?,?,?,?)').run(jobId,seq,JSON.stringify(stable),fenced?3:0);return seq;
 }
 events(){return this.db.prepare('SELECT job_id,sequence,event FROM agent_events WHERE reported IN (0,2) ORDER BY job_id,sequence LIMIT 64').all().map(row=>({...row,event:JSON.parse(row.event)}));}
 eventAttempted(jobId,seq){this.db.prepare('UPDATE agent_events SET reported=2 WHERE job_id=? AND sequence=?').run(jobId,seq);}
 hasEvents(jobId){return this.db.prepare('SELECT 1 FROM agent_events WHERE job_id=? AND reported IN (0,2) LIMIT 1').get(jobId)!==undefined;}
 fenceEvents(jobId){this.db.prepare('INSERT OR IGNORE INTO fenced_job_events(job_id) VALUES(?)').run(jobId);this.db.prepare('UPDATE agent_events SET reported=3 WHERE job_id=? AND reported IN (0,2)').run(jobId);}
 eventReported(jobId,seq){this.db.prepare('UPDATE agent_events SET reported=1 WHERE job_id=? AND sequence=?').run(jobId,seq);}
 stats(){return {unreported:this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE reported=0').get().n,processes:this.db.prepare("SELECT COUNT(*) AS n FROM processes WHERE state='running'").get().n};}
 close(){this.db.close();}
}
