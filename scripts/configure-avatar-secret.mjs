import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

/** Server-only deployment helper. Importing this module never writes a secret.
 * The caller must explicitly provide an environment and authorize execution.
 * stdout/stderr from Wrangler are deliberately never forwarded.
 */
export function configureAvatarSecret({env = process.env, execPath = process.execPath, spawn = spawnSync, logger = console} = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    logger.log('Image API secret not supplied; existing Worker secret is unchanged.');
    return 0;
  }
  const childEnv = {...env};
  delete childEnv.OPENAI_API_KEY;
  let result;
  try {
    result = spawn(execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'OPENAI_API_KEY', '--config', 'apps/api/wrangler.production.jsonc'], {
      input: key, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    });
  } catch {
    logger.error('::error::Unable to configure the server Image API secret. Deployment stopped.');
    return 1;
  }
  if (result.error || result.status !== 0) {
    logger.error('::error::Unable to configure the server Image API secret. Deployment stopped.');
    return 1;
  }
  logger.log('Server Image API secret configured.');
  return 0;
}

// This helper is NOT invoked by CI in this branch. A workflow-authorized operator
// may integrate it separately after review; never put the key in shell arguments.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = configureAvatarSecret();
}
