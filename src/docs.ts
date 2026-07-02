/** Documentation tools — read-only, public; consume the docs site's public endpoints. */
import type { ServerConfig } from './config.js';

function http(config: ServerConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}

/** Full-text/semantic search over the docs + API reference (the site's search route). */
export async function searchDocs(config: ServerConfig, query: string, limit = 10): Promise<string> {
  const url = `${config.docsUrl}/api/search?query=${encodeURIComponent(query)}`;
  const res = await http(config)(url, { headers: { 'User-Agent': config.userAgent } });
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

/** The docs corpus as text (llms.txt / llms-full.txt) — a stable public artifact. */
export async function getLlmsTxt(config: ServerConfig, full = false): Promise<string> {
  const url = `${config.docsUrl}/${full ? 'llms-full.txt' : 'llms.txt'}`;
  const res = await http(config)(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) {
    return `Could not fetch ${url} (HTTP ${res.status}).`;
  }
  return res.text();
}
