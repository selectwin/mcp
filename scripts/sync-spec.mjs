// Refresh the vendored openapi.json from the public docs site (selectwin.io serves the canonical spec).
// Override the source with SELECTWIN_SPEC_URL. The weekly `spec-sync` workflow runs this; by hand:
//
//   node scripts/sync-spec.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'openapi.json');
const url = process.env.SELECTWIN_SPEC_URL || 'https://selectwin.io/api-specs/openapi.json';

const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'selectwin-mcp/sync-spec' } });
if (!res.ok) {
  console.error(`spec fetch failed: HTTP ${res.status} from ${url}`);
  process.exit(1);
}
const spec = await res.json();
if (typeof spec?.openapi !== 'string' || !spec.paths || Object.keys(spec.paths).length === 0) {
  console.error(`not an OpenAPI document with paths: ${url}`);
  process.exit(1);
}
writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`synced openapi.json (${spec.info?.version ?? '?'}, ${Object.keys(spec.paths).length} paths) from ${url}`);
