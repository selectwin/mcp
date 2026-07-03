import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirror tsup's build-time version inject so `MCP_VERSION` resolves to the real
// package version under the unit suite too (lets a test guard against drift).
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __MCP_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
