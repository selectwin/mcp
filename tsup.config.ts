import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/http.ts', 'src/stdio.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: { entry: { server: 'src/server.ts' } },
  sourcemap: true,
  // stdio.js is a CLI bin — add the shebang.
  banner: { js: '' },
});
