import * as os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RunnerError} from './errors.mjs';
const run=promisify(execFile);
export async function diagnostics(action,files,workspaceId){
 if(action.target==='system')return {platform:os.platform(),release:os.release(),architecture:os.arch(),cpuCount:os.availableParallelism(),totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),loadAverage:os.loadavg(),uptimeSeconds:Math.floor(os.uptime())};
 if(action.target==='disk')return files.disk(workspaceId);
 if(action.target==='processes'){
  const limit=action.limit??20;if(!Number.isInteger(limit)||limit<1||limit>100)throw new RunnerError('invalid_diagnostics','Process limit must be between 1 and 100.');
  // comm is the executable name, never command arguments, environment or keys.
  const {stdout}=await run('/bin/ps',['-A','-o','pid=,pcpu=,rss=,comm='],{timeout:3000,maxBuffer:262144});return stdout.trim().split('\n').slice(0,limit).map(line=>{const match=line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);return match?{pid:Number(match[1]),cpuPercent:Number(match[2]),residentMemoryBytes:Number(match[3])*1024,name:match[4].split('/').at(-1)}:null;}).filter(Boolean);
 }
 throw new RunnerError('invalid_diagnostics','Choose system, disk or processes diagnostics.');
}
