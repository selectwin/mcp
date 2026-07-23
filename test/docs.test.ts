import { describe, it, expect } from 'vitest';
import { configFromEnv } from '../src/config';
import { searchDocs, getLlmsTxt } from '../src/docs';

const cfg = (fetchImpl: typeof fetch) => configFromEnv({ docsUrl: 'https://selectwin.io', fetchImpl });

describe('docs tools', () => {
  it('formats search results and encodes the query', async () => {
    let seen = '';
    const fetchImpl = (async (url: any) => {
      seen = String(url);
      return new Response(JSON.stringify([{ content: 'Create a transaction', url: '/docs/guide/transactions/create' }]), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const out = await searchDocs(cfg(fetchImpl), 'create pix');
    expect(seen).toBe('https://selectwin.io/api/search?query=create%20pix');
    expect(out).toContain('Create a transaction');
    expect(out).toContain('/docs/guide/transactions/create');
  });

  it('handles empty search results', async () => {
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    expect(await searchDocs(cfg(fetchImpl), 'zzz')).toContain('No documentation results');
  });

  it('fetches llms.txt / llms-full.txt', async () => {
    let seen = '';
    const fetchImpl = (async (url: any) => {
      seen = String(url);
      return new Response('# Selectwin docs', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await getLlmsTxt(cfg(fetchImpl), false)).toContain('Selectwin docs');
    expect(seen).toBe('https://selectwin.io/llms.txt');
    await getLlmsTxt(cfg(fetchImpl), true);
    expect(seen).toBe('https://selectwin.io/llms-full.txt');
  });
});
