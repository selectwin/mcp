// Refresh the vendored openapi.json from selectwin-docs.
// Override the docs repo path with SELECTWIN_DOCS_REPO.
//
// Run: node scripts/sync-spec.mjs
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const docsRepo = process.env.SELECTWIN_DOCS_REPO || path.resolve(repo, '..', 'Frontend', 'selectwin-docs');
const src = path.join(docsRepo, 'public', 'api-specs', 'openapi.json');

if (!existsSync(src)) {
  console.error(`spec not found: ${src} (set SELECTWIN_DOCS_REPO)`);
  process.exit(1);
}
copyFileSync(src, path.join(repo, 'openapi.json'));
console.log(`synced openapi.json from ${src}`);
