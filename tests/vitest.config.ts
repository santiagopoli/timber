import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import { readFile } from "node:fs/promises";

export default defineConfig({
  resolve: {alias: {"@botspace/runtime": fileURLToPath(new URL("./fixtures/runtime.ts", import.meta.url))}},
  plugins: [
    {name: "computer-text-assets", async load(id) {
      if (/\.(py|sh|md)$/.test(id)) return `export default ${JSON.stringify(await readFile(id, "utf8"))}`;
    }},
    cloudflareTest({wrangler: {configPath: "./tests/wrangler.jsonc"}}),
  ],
  test: {exclude:["packages/runtime/test/local-runtime.test.ts"], include: ["tests/**/*.spec.ts", "packages/runtime/test/**/*.test.ts"], testTimeout: 15_000},
});
