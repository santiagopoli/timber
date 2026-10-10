import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import consoleTestReporter from '../console-test-reporter.mjs';

const reporterPath = fileURLToPath(new URL('../console-test-reporter.mjs', import.meta.url));
function failure(overrides = {}) {
  return {type: 'test:fail', data: {
    name: 'exact failing test', file: join(process.cwd(), 'scripts/tests/example.test.mjs'), line: 17, column: 9,
    details: {error: {failureType: 'testCodeFailure', cause: {stack: 'AssertionError: expected true\n    at example.test.mjs:20:3'}}},
    ...overrides,
  }};
}
async function collect(events, githubActions) {
  if (arguments.length < 2) githubActions = 'true';
  const previous = process.env.GITHUB_ACTIONS;
  if (githubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = githubActions;
  try {
    async function* source() {for (const event of events) {await Promise.resolve(); yield event;}}
    return (await Array.fromAsync(consoleTestReporter(source()))).join('');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
}

test('async test:fail events annotate the exact test location and underlying assertion stack', async () => {
  const output = await collect([{type: 'test:pass', data: {}}, failure(), {type: 'test:diagnostic', data: {message: 'ignored'}}]);
  assert.equal(output, '::error file=scripts/tests/example.test.mjs,line=17,col=9::exact failing test%0AAssertionError: expected true%0A    at example.test.mjs:20:3\n');
});

test('annotations require GITHUB_ACTIONS to be exactly true but always consume events', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) assert.equal(await collect([failure()], value), '');
});

test('workflow data and file properties are escaped without enabling command injection', async () => {
  const output = await collect([failure({
    name: 'test 50%\r\n::error::not another command', file: 'a%,:b\r\n.test.mjs',
    details: {error: {message: '\u001b[31massert 100%\u001b[0m\r\n::warning::not another command\u0000'}},
  })]);
  assert.equal(output, '::error file=a%25%2C%3Ab%0D%0A.test.mjs,line=17,col=9::test 50%25%0D%0A::error::not another command%0Aassert 100%25%0D%0A::warning::not another command\n');
  assert.equal(output.split('\n').length, 2, 'only the final newline is literal');
});

test('parent subtestsFailed summaries and expected TODO failures do not duplicate errors', async () => {
  const output = await collect([
    failure(), failure({name: 'parent', details: {error: {failureType: 'subtestsFailed', cause: '1 subtest failed'}}}),
    failure({name: 'future behavior', todo: 'not implemented yet'}),
  ]);
  assert.equal(output.match(/^::error/gm)?.length, 1);
  assert.equal(output.includes('parent'), false);
  assert.equal(output.includes('future behavior'), false);
});

test('annotation sizes and stack depth are bounded after escaping', async () => {
  const output = await collect([failure({
    name: 'N'.repeat(5000), file: '%:,'.repeat(5000),
    details: {error: {stack: '%'.repeat(20000) + '\n' + 'frame\n'.repeat(100)}},
  })]);
  const [properties, message] = output.slice('::error '.length, -1).split('::');
  assert.ok(properties.length < 1100);
  assert.ok(message.length <= 6000);
  assert.match(properties, /\[truncated\]/);
  assert.match(message, /\[truncated\]/);
  assert.equal(message.includes('N'.repeat(513)), false);
  const frames = await collect([failure({details: {error: {stack: Array.from({length: 30}, (_, i) => `frame ${i}`).join('\n')}}})]);
  assert.match(frames, /frame 11/);
  assert.equal(frames.includes('frame 12'), false);
});

test('only message or stack is read, never arbitrary assertion properties or environment', async () => {
  const error = {message: 'safe diagnostic'};
  Object.defineProperties(error, {
    actual: {get() {throw new Error('must not read actual');}},
    expected: {get() {throw new Error('must not read expected');}},
    extra: {get() {throw new Error('must not inspect arbitrary error properties');}},
  });
  const output = await collect([failure({details: {error}})]);
  assert.match(output, /safe diagnostic/);
  assert.equal(output.includes('GITHUB_ACTIONS'), false);
});

test('missing locations and details still produce valid annotations, not invalid line properties', async () => {
  assert.equal(await collect([failure({name: undefined, file: undefined, details: undefined})]),
    '::error::Unnamed test%0ATest failed (no assertion detail provided)\n');
  const output = await collect([failure({line: -1, column: NaN, details: {error: {cause: 'runner failed'}}})]);
  assert.match(output, /runner failed/);
  assert.equal(output.includes(',line='), false);
  assert.equal(output.includes(',col='), false);
});

test('real Node dual reporters preserve spec output and nonzero exit with one child annotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'console-test-reporter-'));
  try {
    const file = join(directory, 'failure.test.mjs');
    writeFileSync(file, `import {test} from 'node:test';
import assert from 'node:assert/strict';
test('synthetic parent', async t => {
  await t.test('synthetic child assertion', () => assert.equal(1, 2));
});\n`);
    for (const githubActions of ['true', 'false']) {
      const env = {...process.env, GITHUB_ACTIONS: githubActions, FORCE_COLOR: '0'};
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        '--test', '--test-reporter=spec', `--test-reporter=${reporterPath}`,
        '--test-reporter-destination=stdout', '--test-reporter-destination=stdout', file,
      ], {env, encoding: 'utf8', maxBuffer: 128 * 1024});
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /synthetic child assertion/);
      assert.match(result.stdout, /Expected values to be strictly equal/);
      assert.match(result.stdout, /failing tests:/, 'human spec summary is preserved');
      const annotations = result.stdout.split('\n').filter(line => line.startsWith('::error'));
      assert.equal(annotations.length, githubActions === 'true' ? 1 : 0);
      if (githubActions === 'true') {
        assert.match(annotations[0], /^::error file=.+failure\.test\.mjs,line=4,col=11::synthetic child assertion%0AAssertionError/);
        assert.match(annotations[0], /1 !== 2/);
      }
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
