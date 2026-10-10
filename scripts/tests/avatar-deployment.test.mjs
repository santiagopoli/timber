import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureAvatarSecret} from '../configure-avatar-secret.mjs';

// Standalone safety contract: no workflow modification, cloud command or provider
// invocation. CI secret wiring is deferred to a workflow-authorized operator.
function simulate(key, subprocessResult = {status: 0}, throws = false) {
  const calls = [], logs = [], errors = [];
  const env = {OPENAI_API_KEY: key, CLOUDFLARE_API_TOKEN: 'test-only-cloudflare-placeholder'};
  const status = configureAvatarSecret({
    env, execPath: '/test/node',
    spawn: (...args) => {calls.push(args); if (throws) throw new Error('untrusted-provider-detail'); return subprocessResult;},
    logger: {log: value => logs.push(value), error: value => errors.push(value)},
  });
  return {calls, logs, errors, status, env};
}

test('Image API secret helper sends a synthetic value only through stdin and removes it from child environment', () => {
  const fake = 'test-only-image-api-placeholder';
  const {calls, logs, errors, status, env} = simulate(fake);
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, '/test/node');
  assert.deepEqual(args, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'OPENAI_API_KEY', '--config', 'apps/api/wrangler.production.jsonc']);
  assert.equal(options.input, fake);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(env.OPENAI_API_KEY, fake, 'does not mutate caller environment');
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(JSON.stringify([args, logs, errors]).includes(fake), false);
});

for (const key of [undefined, '']) test(`missing Image API configuration (${String(key)}) does not invent or erase a Worker secret`, () => {
  const {calls, logs, status} = simulate(key);
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
  assert.match(logs.join(' '), /existing Worker secret is unchanged/);
});

for (const failure of [{status: 1}, {status: null, error: new Error('untrusted-provider-detail')}, 'throw']) {
  test(`secret-helper failure (${failure === 'throw' ? failure : String(failure.status)}) stops with only a fixed diagnostic`, () => {
    const {calls, logs, errors, status} = simulate('test-only-placeholder', {...failure, stderr: 'untrusted-provider-detail', stdout: 'untrusted-provider-detail'}, failure === 'throw');
    assert.equal(calls.length, 1);
    assert.equal(status, 1, 'caller must stop deployment for any nonzero status');
    assert.match(errors.join(' '), /Deployment stopped/);
    assert.equal(JSON.stringify([logs, errors]).includes('untrusted-provider-detail'), false);
    assert.equal(JSON.stringify([logs, errors]).includes('test-only-placeholder'), false);
  });
}
