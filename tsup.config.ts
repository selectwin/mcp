import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Single source of truth for the version: package.json, baked in at build time.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  entry: ['src/server.ts', 'src/http.ts', 'src/stdio.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: { entry: { server: 'src/server.ts' } },
  sourcemap: true,
  define: { __MCP_VERSION__: JSON.stringify(version) },
  // stdio.js is a CLI bin — add the shebang.
  banner: { js: '' },
});
