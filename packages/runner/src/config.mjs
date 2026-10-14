import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {secureDirectory,writePrivateFile} from './credentials.mjs';
import {RunnerError} from './errors.mjs';
export async function saveConfig(stateDir,config){await secureDirectory(stateDir);await writePrivateFile(join(stateDir,'config.json'),JSON.stringify(config));}
export async function loadConfig(stateDir){
 try {const path=join(stateDir,'config.json'),stat=await lstat(path);if(stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new RunnerError('unsafe_config','Runner configuration requires an owned file with mode 0600.');return JSON.parse(await readFile(path,'utf8'));}
 catch(error){if(error.code==='ENOENT')throw new RunnerError('not_connected','Run timber-runner connect first.');throw error;}
}
