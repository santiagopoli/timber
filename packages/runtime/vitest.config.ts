import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './packages/runtime/test/wrangler.jsonc' } })],
  test: { include: ['packages/runtime/test/harness.spec.ts'], testTimeout: 20_000 },
});
