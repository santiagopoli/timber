import {build} from 'esbuild';
import {mkdir,chmod} from 'node:fs/promises';
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
await build({entryPoints:{cli:new URL('./src/cli.mjs',import.meta.url).pathname,'session-host':new URL('./src/session-host.mjs',import.meta.url).pathname},outdir:new URL('./dist/',import.meta.url).pathname,outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',banner:{js:'#!/usr/bin/env node'},logLevel:'warning'});
await chmod(new URL('./dist/cli.mjs',import.meta.url),0o755);
