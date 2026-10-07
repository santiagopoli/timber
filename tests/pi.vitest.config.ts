import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins:[
    {name:"computer-text-assets",async load(id) {
      if(/\.(py|sh|md)$/.test(id)) return `export default ${JSON.stringify(await readFile(id,"utf8"))}`;
    }},
    cloudflareTest({wrangler:{configPath:"./tests/pi/wrangler.jsonc"}}),
  ],
  test:{include:["tests/pi/**/*.integration.ts"],testTimeout:20_000},
});
