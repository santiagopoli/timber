#!/usr/bin/env node
import { cloudRequest, loadConnectionConfig, LoginError } from './chatgpt-login.mjs';

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) { console.log('npm run chatgpt:status [-- --verify]\nShows the connected ChatGPT account. --verify makes one small real request using an available account model. No tokens are displayed.'); return; }
  for (const arg of args) if (arg !== '--verify') throw new LoginError('Unknown option. Use npm run chatgpt:status -- --help.');
  const config = await loadConnectionConfig();
  const status = await cloudRequest(config);
  console.log(`ChatGPT: ${status.connected ? 'connected' : 'not connected'}.`);
  if (status.account?.email) console.log(`Account: ${String(status.account.email).replace(/[\x00-\x1f\x7f]/g, '')}`);
  if (!status.connected) { console.log('Run npm run chatgpt:login on your computer to authorize ChatGPT plan use.'); return; }
  console.log('A connection alone does not confirm current model access.');
  if (args.has('--verify')) {
    const result = await cloudRequest(config, { method: 'POST', suffix: '/verify', body: {} });
    if (result.ok !== true || typeof result.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(result.model)) throw new LoginError('The backend did not confirm model access.');
    console.log(`Verified: ${result.model} completed a real request.`);
  } else console.log('Run npm run chatgpt:status -- --verify to test model access.');
}
main().catch((error) => { console.error(error instanceof LoginError ? error.message : 'Could not read ChatGPT connection status. Check local configuration and connectivity.'); process.exitCode = 1; });
