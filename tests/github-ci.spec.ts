import {describe,it,expect,vi} from 'vitest';
import {inspectGitHubCI} from '../apps/api/src/github-ci';
const repo='owner/repo',token='test-private-host-token';
const run={id:42,name:'Verify',status:'completed',conclusion:'failure',head_sha:'a'.repeat(40),repository:{full_name:repo},html_url:`https://github.com/${repo}/actions/runs/42`};
function network(options:{private?:boolean;location?:string;log?:string;jobs?:unknown[];runRepo?:string}={}){
 const calls:{url:string;headers:Headers}[]=[];
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);calls.push({url,headers:new Headers(init?.headers)});
  if(url===`https://api.github.com/repos/${repo}`)return Response.json({full_name:repo,private:options.private??false});
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:[{...run,credential:token}]});
  if(url.endsWith('/actions/runs/42'))return Response.json({...run,repository:{full_name:options.runRepo??repo}});
  if(url.endsWith('/actions/runs/42/jobs?per_page=30'))return Response.json({jobs:options.jobs??[{id:71,run_id:42,name:'desktop-image',status:'completed',conclusion:'failure',steps:[{name:'Smoke',status:'completed',conclusion:'failure'}]},{id:72,run_id:42,name:'Deploy',status:'completed',conclusion:'skipped'}]});
  if(url.endsWith('/actions/jobs/71/logs'))return new Response(null,{status:302,headers:{location:options.location??'https://productionresultssa7.blob.core.windows.net/logs/job?sig=private-signature'}});
  if(url.startsWith('https://productionresultssa7.blob.core.windows.net/'))return new Response(options.log??`startup\nAssertionError: expected completed, exit 127\n${token}`);
  throw new Error(`unexpected request ${token}`);
 }) as unknown as typeof fetch;
 return {fetcher,calls};
}
describe('read-only repository CI inspection',()=>{
 it('lists commit/branch CI with no computer credentials, writes or arbitrary response fields',async()=>{
  const {fetcher,calls}=network();const result=await inspectGitHubCI(repo,{branch:'feature/task',commit:'a'.repeat(40)},token,fetcher);
  expect(result.runs).toHaveLength(1);expect(JSON.stringify(result)).not.toContain(token);
  expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${token}`);
  expect(calls[1]!.headers.has('authorization')).toBe(false);
  expect(new URL(calls[1]!.url).searchParams.get('branch')).toBe('feature/task');
 });
 it('reads real job/step failure evidence while never forwarding authentication to a log redirect',async()=>{
  const {fetcher,calls}=network({private:true});const result=await inspectGitHubCI(repo,{runId:42},token,fetcher);
  expect(result.jobs?.[0]).toMatchObject({id:71,conclusion:'failure',steps:[{name:'Smoke',conclusion:'failure'}]});
  expect(result.jobs?.[1]).toMatchObject({name:'Deploy',conclusion:'skipped'});
  expect(result.jobLog?.tail).toContain('exit 127');expect(result.jobLog?.tail).not.toContain(token);
  expect(calls.at(-1)?.headers.has('authorization')).toBe(false);expect(JSON.stringify(result)).not.toContain('private-signature');
 });
 it.each(['http://127.0.0.1/log','https://api.github.com.evil.test/log','https://evil.test/log','https://user:password@productionresultssa7.blob.core.windows.net/log'])('refuses untrusted log redirect %s',async location=>{
  const {fetcher,calls}=network({location});const result=await inspectGitHubCI(repo,{runId:42},token,fetcher);
  expect(result.jobLog).toBeUndefined();expect(result.logNotice).toContain('log location');expect(calls).toHaveLength(4);
 });
 it('does not request logs for a job outside the selected run',async()=>{
  const {fetcher,calls}=network({jobs:[{id:71,run_id:99,status:'completed',conclusion:'failure'}]});
  await expect(inspectGitHubCI(repo,{runId:42,jobId:71},token,fetcher)).rejects.toMatchObject({code:'invalid_workflow_job'});
  expect(calls.some(call=>call.url.includes('/actions/jobs/'))).toBe(false);
 });
 it('rejects cross-repository run metadata and invalid selectors',async()=>{
  const {fetcher}=network({runRepo:'someone/other'});await expect(inspectGitHubCI(repo,{runId:42},token,fetcher)).rejects.toMatchObject({code:'github_ci_invalid_response'});
  const none=vi.fn();for(const input of [{runId:-1},{jobId:71},{commit:'../private'},{branch:'bad\nbranch'}])await expect(inspectGitHubCI(repo,input,token,none)).rejects.toMatchObject({status:400});
  await expect(inspectGitHubCI('owner/../../private',{},token,none)).rejects.toMatchObject({status:400});expect(none).not.toHaveBeenCalled();
 });
 it('bounds huge logs and retains failure lines in the tail',async()=>{
  const {fetcher}=network({log:'x'.repeat(100_000)+'\nAssertionError: failing check'});const result=await inspectGitHubCI(repo,{runId:42},token,fetcher);
  expect(result.jobLog!.tail.length).toBeLessThanOrEqual(32_000);expect(result.jobLog!.tail).toContain('AssertionError');
  const oversized=network({log:'x'.repeat(8_000_001)});const bounded=await inspectGitHubCI(repo,{runId:42},token,oversized.fetcher);expect(bounded.jobLog).toBeUndefined();expect(bounded.logNotice).toContain('too large');
 });
 it('never exposes provider error bodies or network exceptions',async()=>{
  const error=vi.fn(async()=>new Response(token,{status:403}));await expect(inspectGitHubCI(repo,{},token,error)).rejects.not.toHaveProperty('message',token);
  const thrown=vi.fn(async()=>{throw new Error(token);});await expect(inspectGitHubCI(repo,{},token,thrown)).rejects.toMatchObject({code:'github_ci_unavailable'});
 });
});
