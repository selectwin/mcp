import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server';
import { configFromEnv, type ServerConfig } from '../src/config';

async function connect(config: ServerConfig) {
  const server = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const mockFetch = (body: unknown, status = 200) =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

const textOf = (res: any): string => res.content[0].text as string;

describe('MCP server', () => {
  it('registers the docs + api tools and the resources', async () => {
    const client = await connect(configFromEnv({ selectKey: 'sk_test_x' }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['call_api', 'get_llms_txt', 'get_openapi', 'list_api_reference', 'search_docs']);
    const resources = (await client.listResources()).resources.map((r) => r.name).sort();
    expect(resources).toEqual(['llms', 'openapi']);
  });

  it('list_api_reference returns the grouped reference', async () => {
    const client = await connect(configFromEnv({}));
    const res = await client.callTool({ name: 'list_api_reference', arguments: {} });
    expect(textOf(res)).toContain('getBalance');
  });

  it('call_api performs a read using the SelectKey', async () => {
    const client = await connect(configFromEnv({ selectKey: 'sk_test_x', fetchImpl: mockFetch({ balance: 42 }) }));
    const res = await client.callTool({ name: 'call_api', arguments: { operationId: 'getBalance' } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('42');
  });

  it('call_api refuses writes when disabled', async () => {
    const client = await connect(configFromEnv({ selectKey: 'sk_test_x' }));
    const res = await client.callTool({
      name: 'call_api',
      arguments: { operationId: 'createCustomer', body: { firstName: 'Ana' } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/writes are disabled/i);
  });

  it('search_docs is available without a SelectKey', async () => {
    const client = await connect(
      configFromEnv({ fetchImpl: mockFetch([{ content: 'PIX guide', url: '/docs/x' }]) }),
    );
    const res = await client.callTool({ name: 'search_docs', arguments: { query: 'pix' } });
    expect(textOf(res)).toContain('PIX guide');
  });
});
