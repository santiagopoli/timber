/** Build a reviewed public install artifact; no npm publication or local state. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=resolve(root,'apps/console/public/runner');
const temporary=await mkdtemp(join(tmpdir(),'timber-runner-pack-'));
const permitted=new Set(['package/package.json','package/README.md','package/dist/cli.mjs','package/dist/session-host.mjs']);
try {
  // npm prepack runs the runner's build. Dependencies remain normal exact npm
  // dependencies; the archive contains our executable bundle and public docs.
  const {stdout}=await exec('npm',['pack','--workspace','@timber/runner','--pack-destination',temporary,'--json'],{cwd:root,maxBuffer:1024*1024});
  const receipts=JSON.parse(stdout);
  if(receipts.length!==1||receipts[0].name!=='@timber/runner'||!/^timber-runner-[\w.-]+\.tgz$/.test(receipts[0].filename))throw new Error('Unexpected runner pack receipt.');
  const archive=join(temporary,receipts[0].filename);
  const listing=await exec('tar',['-tzf',archive],{maxBuffer:1024*1024});
  const members=listing.stdout.trim().split('\n');
  if(members.length!==permitted.size||new Set(members).size!==permitted.size||members.some(member=>!permitted.has(member)))throw new Error('Runner archive contains unexpected or missing files; refusing publication.');
  // Extract only the known package metadata for a second packaging check.
  const packaged=JSON.parse((await exec('tar',['-xOzf',archive,'package/package.json'],{maxBuffer:1024*1024})).stdout);
  if(packaged.name!=='@timber/runner'||packaged.version!==receipts[0].version||packaged.bin?.['timber-runner']!=='./dist/cli.mjs')throw new Error('Runner executable metadata did not match its pack receipt.');
  const bytes=await readFile(archive);
  const manifest={schemaVersion:1,name:packaged.name,version:packaged.version,filename:'timber-runner.tgz',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,node:packaged.engines.node};
  await mkdir(destination,{recursive:true});
  await writeFile(join(destination,manifest.filename),bytes,{mode:0o644});
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
  await chmod(join(destination,manifest.filename),0o644);
  await chmod(join(destination,'manifest.json'),0o644);
  console.log(`Runner ${manifest.version}: ${manifest.bytes} bytes; SHA256 ${manifest.sha256}`);
} finally {await rm(temporary,{recursive:true,force:true});}
