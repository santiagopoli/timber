import {readFile, writeFile} from 'node:fs/promises';

// CI promotes the exact image exercised by the desktop smoke job. Pin the
// registry digest rather than a mutable tag, retaining a commit-addressed receipt.
const [configPath, digestsPath, receiptPath] = process.argv.slice(2);
const commit = process.env.GITHUB_SHA;
if (!configPath || !digestsPath || !receiptPath || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Expected config, Docker RepoDigests, receipt paths and GITHUB_SHA.');
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const computer = config.containers?.find(value => value.class_name === 'ComputerDO');
const baseline = computer?.images?.base?.image;
if (typeof baseline !== 'string' || !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/timber-computer@sha256:[a-f0-9]{64}$/.test(baseline)) {
  throw new Error('The production computer must already name its managed registry repository.');
}
const repository = baseline.split('@')[0];
const digests = JSON.parse(await readFile(digestsPath, 'utf8'));
const image = Array.isArray(digests) && digests.find(value => typeof value === 'string'
  && value.startsWith(`${repository}@`) && /^sha256:[a-f0-9]{64}$/.test(value.slice(repository.length + 1)));
if (!image) throw new Error('The verified image has no digest in the configured computer repository.');
computer.images.base.image = image;
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
await writeFile(receiptPath, `${JSON.stringify({sourceCommit: commit, computerImage: image}, null, 2)}\n`);
console.log(`Production computer image: ${image}`);
