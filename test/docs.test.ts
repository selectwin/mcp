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
    expect(seen).toBe('https://selectwin.io/api/search?query=create%20pix&limit=10');
    expect(out).toContain('Create a transaction');
    expect(out).toContain('/docs/guide/transactions/create');
  });

  it('handles empty search results', async () => {
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    expect(await searchDocs(cfg(fetchImpl), 'zzz')).toContain('No documentation results');
  });

  it('fetches llms.txt, a sector, or llms-full.txt', async () => {
    let seen = '';
    const fetchImpl = (async (url: any) => {
      seen = String(url);
      return new Response('# Selectwin docs', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await getLlmsTxt(cfg(fetchImpl))).toContain('Selectwin docs');
    expect(seen).toBe('https://selectwin.io/llms.txt');
    await getLlmsTxt(cfg(fetchImpl), { sector: 'webhooks' });
    expect(seen).toBe('https://selectwin.io/llms/webhooks.txt');
    await getLlmsTxt(cfg(fetchImpl), { full: true });
    expect(seen).toBe('https://selectwin.io/llms-full.txt');
  });

  it('refuses a sector that is not a slug, and names an unknown one', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await getLlmsTxt(cfg(fetchImpl), { sector: '../llms-full' })).toMatch(/Unknown docs sector/);
    expect(calls).toBe(0);
    expect(await getLlmsTxt(cfg(fetchImpl), { sector: 'nada' })).toMatch(/Unknown docs sector 'nada'/);
  });
});
