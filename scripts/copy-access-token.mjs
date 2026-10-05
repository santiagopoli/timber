#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readClientConfig } from './client-config.mjs';

const {apiToken} = await readClientConfig();
if (!apiToken) throw new Error('Run npm run access:setup first.');
if (process.platform !== 'darwin') throw new Error('Clipboard helper currently supports macOS only. Read your private .local/client.json with your preferred credential tool.');
const child = spawn('pbcopy', [], {stdio:['pipe','ignore','pipe']});
child.stdin.end(apiToken);
const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
if (code !== 0) throw new Error('Could not copy token.');
console.log('Console token copied to your clipboard. Paste it into the Timber console access field.');
