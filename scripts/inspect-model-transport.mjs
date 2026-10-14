import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execute=promisify(execFile);
const states=new Set(['active','degraded','running','failed','stopping','stopped','unhealthy','provisioning','inactive']);
const sizes=new Set(['lite','standard-1','standard-2','standard-3','standard-4']);
export function transportProjection(application,instances){
  const config=application?.configuration??{};
  return {state:states.has(application?.state)?application.state:'unknown',
    instanceType:sizes.has(config.instance_type)?config.instance_type:'unknown',
    instances:(Array.isArray(instances)?instances:instances?.instances??[]).slice(0,10).map(instance=>({state:states.has(instance?.state)?instance.state:'unknown'})),
    resources:Object.fromEntries(['vcpu','memory_mib','disk_mb'].filter(name=>Number.isFinite(config[name])&&config[name]>=0).map(name=>[name,config[name]])),
  };
}
async function main(){
  if(process.env.GITHUB_REF!=='refs/heads/main')throw new Error('inspection_requires_main');
  const cli=async args=>{
    const result=await execute('npx',['--yes','wrangler@4.147.0','containers',...args,'--json','--config','apps/api/wrangler.production.jsonc'],{timeout:120_000,maxBuffer:2_000_000});
    return JSON.parse(result.stdout);
  };
  const list=await cli(['list']);
  const applications=list.filter(item=>typeof item?.name==='string'&&/timber.*chatgpttransport/i.test(item.name)&&/^[a-f0-9-]{36}$/i.test(item.id));
  const output=[];
  for(const app of applications.slice(0,2)){
    const info=await cli(['info',app.id]),instances=await cli(['instances',app.id]);
    output.push(transportProjection({...info,state:app.state},instances));
  }
  console.log(JSON.stringify({transportApplications:output}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('transport_inspection_failed');process.exitCode=1;});
