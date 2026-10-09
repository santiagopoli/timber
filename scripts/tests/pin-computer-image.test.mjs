import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const execute = promisify(execFile);
const repository = `registry.cloudflare.com/${'a'.repeat(32)}/timber-computer`;
const baseline = `${repository}@sha256:${'b'.repeat(64)}`;
const verified = `${repository}@sha256:${'c'.repeat(64)}`;
const revision = 'd'.repeat(40);

for (const valid of [true, false]) test(`image promotion ${valid ? 'pins the verified digest and source revision' : 'rejects another repository without changing the deploy config'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'timber-image-pin-'));
  try {
    const config = join(directory, 'wrangler.jsonc'), digests = join(directory, 'digests.json'), receipt = join(directory, 'release.json');
    const original = JSON.stringify({name: 'timber-api', containers: [{class_name: 'ComputerDO', images: {base: {image: baseline}}}]});
    await writeFile(config, original);
    await writeFile(digests, JSON.stringify([valid ? verified : verified.replace('/timber-computer@', '/unrelated@')]));
    const run = execute(process.execPath, ['scripts/pin-computer-image.mjs', config, digests, receipt], {env: {...process.env, GITHUB_SHA: revision}});
    if (valid) {
      await run;
      assert.equal(JSON.parse(await readFile(config, 'utf8')).containers[0].images.base.image, verified);
      assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {sourceCommit: revision, computerImage: verified});
    } else {
      await assert.rejects(run, /no digest in the configured computer repository/);
      assert.equal(await readFile(config, 'utf8'), original);
      await assert.rejects(readFile(receipt), {code: 'ENOENT'});
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
