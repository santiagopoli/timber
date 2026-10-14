import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const verified='d10b8ee7a0dec62a936f007719cfc192f9238388';
const file='apps/api/src/chatgpt-transport.ts';
const allowed=new Set([file,'.github/workflows/model-catalog-diagnostics.yml','.github/workflows/deploy-model-transport.yml',
  'scripts/guard-model-transport-deploy.mjs','scripts/inspect-model-transport.mjs','scripts/probe-transport-runtime.mjs','tests/chatgpt-transport.spec.ts']);
const changed=execFileSync('git',['diff','--name-only',verified,'HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
if(changed.some(name=>!allowed.has(name)))throw new Error('transport_deployment_contains_unverified_changes');
const current=await readFile(file,'utf8');
if(createHash('sha256').update(current).digest('hex')!=='f52034f321d604516883ccf3f4746991fdc7fdf90704bae41bdb634cdcd28015')throw new Error('transport_deployment_is_not_the_exact_resource_correction');
const receipt=JSON.parse(await readFile('.verified-transport/release.json','utf8'));
if(receipt.sourceCommit!==verified||receipt.computerImage!=='registry.cloudflare.com/3acfff91febe1ba644c6358ae5612736/timber-computer@sha256:47ad585557cea558179799bb290dcef78ec25998efeb4c962d26de4f089790d9')throw new Error('transport_deployment_image_not_verified');
const path='apps/api/wrangler.production.jsonc',config=JSON.parse(await readFile(path,'utf8'));
for(const container of config.containers??[])if(['ComputerDO','ChatGPTTransportDO'].includes(container.class_name))container.images.base.image=receipt.computerImage;
await writeFile(path,JSON.stringify(config,null,2)+'\n');
console.log('Only the exact transport size correction is allowed; the image is the one already exercised in production CI.');
