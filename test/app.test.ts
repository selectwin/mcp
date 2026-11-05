/**
 * The HTTP host end to end, on an ephemeral port: the hosted server with OAuth on — the protected resource metadata,
 * the docs tools without sign-in, the 401 that makes a client sign in, the client's token traded (never forwarded),
 * and the SelectKey path unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMcpHttpServer } from '../src/app';
import type { ExchangeResult, TokenExchanger } from '../src/oauth';

process.env.MCP_HOSTED = 'true';

const resource = { issuer: 'https://api.selectwin.io/v1/authentication/oauth', resource: 'https://mcp.selectwin.io/mcp' };
const exchanged: string[] = [];
let exchangeAnswer: ExchangeResult = { ok: true, token: 'api-token' };
const exchanger: TokenExchanger = {
  exchange: async (subject: string) => {
    exchanged.push(subject);
    return exchangeAnswer;
  },
  size: () => 0,
};
const apiCalls: Array<{ url: string; headers: Record<string, string> }> = [];
const fetchImpl = (async (url: string, init: RequestInit) => {
  apiCalls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
  return new Response(JSON.stringify({ balance: 42 }), { status: 200 });
}) as unknown as typeof fetch;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createMcpHttpServer({ mcpPath: '/mcp', allowedHosts: [], allowedOrigins: [], rateLimitPerMinute: 1000, oauth: { resource, exchanger }, fetchImpl });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  exchanged.length = 0;
  apiCalls.length = 0;
  exchangeAnswer = { ok: true, token: 'api-token' };
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
const callBalance = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_api', arguments: { operationId: 'getBalance' } } };

describe('hosted MCP with OAuth', () => {
  it('serves the protected resource metadata at both well-known paths, readable from a browser', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toMatchObject({ resource: 'https://mcp.selectwin.io/mcp', authorization_servers: [resource.issuer], scopes_supported: ['mcp:read'] });
    }
  });

  it('lists the tools and runs the docs tools without signing in; the tools declare their security schemes', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"call_api"');
    expect(text).toContain('"securitySchemes":[{"type":"oauth2","scopes":["mcp:read"]}]');
    expect(text).toContain('"securitySchemes":[{"type":"noauth"}]');
    expect(exchanged).toHaveLength(0);
  });

  it('call_api without a credential answers HTTP 401 with the challenge — before the SDK, so the client signs in', async () => {
    const res = await rpc(callBalance);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", error_description="Sign in to Selectwin to use this tool", resource_metadata="https://mcp.selectwin.io/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
    );
    expect(apiCalls).toHaveLength(0);
  });

  it('a signed-in call trades the client token and calls the API with the API token — never the client one', async () => {
    const res = await rpc(callBalance, { authorization: 'Bearer client-mcp-token' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('42');
    expect(exchanged).toEqual(['client-mcp-token']);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.headers.authorization).toBe('Bearer api-token');
    expect(apiCalls[0]!.headers.selectkey).toBeUndefined();
    expect(JSON.stringify(apiCalls)).not.toContain('client-mcp-token');
  });

  it('a token the authorization server refuses is a 401 (sign in again); an exchange outage is a 503, not a sign-in loop', async () => {
    exchangeAnswer = { ok: false, kind: 'rejected', detail: 'invalid_grant' };
    let res = await rpc(callBalance, { authorization: 'Bearer stale' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    exchangeAnswer = { ok: false, kind: 'unavailable', detail: 'http_503' };
    res = await rpc(callBalance, { authorization: 'Bearer any' });
    expect(res.status).toBe(503);
    expect(apiCalls).toHaveLength(0);
  });

  it('the SelectKey still works as before, with no exchange', async () => {
    const res = await rpc(callBalance, { selectkey: 'sk_test_abc' });
    expect(res.status).toBe(200);
    expect(exchanged).toHaveLength(0);
    expect(apiCalls[0]!.headers.selectkey).toBe('sk_test_abc');
    expect(apiCalls[0]!.headers.authorization).toBeUndefined();
  });

  it('GET and DELETE on the endpoint are 405 (stateless)', async () => {
    expect((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('the 2026-07-28 protocol (SDK v2): a modern client on the same endpoint', () => {
  async function modernClient(headers: Record<string, string> = {}) {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const client = new Client({ name: 'modern-test', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
    await client.connect(transport);
    return client;
  }

  it('connects without initialize, lists the tools and runs a docs tool anonymously', async () => {
    const client = await modernClient();
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['call_api', 'get_llms_txt', 'get_operation', 'list_api_reference', 'search_docs']);
    const ref = await client.callTool({ name: 'list_api_reference', arguments: {} });
    expect((ref.content as Array<{ text: string }>)[0]!.text).toContain('getBalance [callable]');
    await client.close();
  });

  it('a SelectKey caller runs call_api in the modern era too', async () => {
    const client = await modernClient({ selectkey: 'sk_test_modern' });
    const res = await client.callTool({ name: 'call_api', arguments: { operationId: 'getBalance' } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('42');
    expect(apiCalls.at(-1)!.headers.selectkey).toBe('sk_test_modern');
    await client.close();
  });

  it('call_api without a credential is still the HTTP 401 that asks the client to sign in', async () => {
    const client = await modernClient();
    await expect(client.callTool({ name: 'call_api', arguments: { operationId: 'getBalance' } })).rejects.toThrow();
    expect(apiCalls).toHaveLength(0);
    await client.close();
  });
});
