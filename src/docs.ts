/** Documentation tools — read-only, public; consume the docs site's public endpoints. */
import type { ServerConfig } from './config.js';

const DOCS_TIMEOUT_MS = 20_000;

function get(config: ServerConfig, url: string): Promise<Response> {
  return (config.fetchImpl ?? fetch)(url, {
    headers: { 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(DOCS_TIMEOUT_MS),
  });
}

/** Full-text/semantic search over the docs + API reference (the site's search route; it returns at most 30). */
export async function searchDocs(config: ServerConfig, query: string, limit = 10): Promise<string> {
  const url = `${config.docsUrl}/api/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit, 30)}`;
  const res = await get(config, url);
  if (!res.ok) {
    return `Search failed (HTTP ${res.status}) for "${query}".`;
  }
  const data: unknown = await res.json().catch(() => null);
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return `No documentation results for "${query}".`;
  }
  const lines = items.slice(0, limit).map((it: any, i: number) => {
    const title = it.content ?? it.title ?? it.id ?? 'result';
    const path = it.url ?? it.href ?? '';
    return `${i + 1}. ${title}${path ? `\n   ${config.docsUrl}${path}` : ''}`;
  });
  return `Documentation results for "${query}":\n\n${lines.join('\n')}`;
}

/** A docs sector slug as the site names them in llms.txt (`/llms/<slug>.txt`), e.g. `pagamentos`, `webhooks`. */
const SECTOR = /^[a-z0-9-]{1,64}$/;

/**
 * The docs corpus as text — a stable public artifact. By default the index (`llms.txt`, which lists the sectors);
 * `sector` returns one sector (`/llms/<sector>.txt`); `full` the whole corpus (`llms-full.txt`, ~1 MB — for the
 * resource, too big for a tool answer).
 */
export async function getLlmsTxt(config: ServerConfig, options: { full?: boolean; sector?: string } = {}): Promise<string> {
  let file = 'llms.txt';
  if (options.sector !== undefined) {
    if (!SECTOR.test(options.sector)) return `Unknown docs sector '${options.sector}'. The sectors are listed in llms.txt.`;
    file = `llms/${options.sector}.txt`;
  } else if (options.full) {
    file = 'llms-full.txt';
  }
  const url = `${config.docsUrl}/${file}`;
  const res = await get(config, url);
  if (!res.ok) {
    return res.status === 404 && options.sector !== undefined
      ? `Unknown docs sector '${options.sector}'. The sectors are listed in llms.txt.`
      : `Could not fetch ${url} (HTTP ${res.status}).`;
  }
  return res.text();
}
