/**
 * Security sweep 31 (11/11/2026), MCP-1: one anonymous request to the hosted server could take it down for everyone —
 * a JSON-RPC batch of 100 `resources/read selectwin://openapi.json` built a ~200 MB answer (+584 MB of memory measured,
 * in a 256 MB container), and a burst or a slow reader stacked answers the same way. Pinned here: batches are refused,
 * the multi-MB resources are local-only, and what one client (or everyone) holds at once is bounded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpHttpServer, type McpHttpOptions } from '../src/app';
import { createServer } from '../src/server';
import { configFromEnv } from '../src/config';
import { createInFlightLimiter, createRateLimiter, positiveIntEnv, rateKey } from '../src/guard';

process.env.MCP_HOSTED = 'true';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A fake API that holds every call until `open()` — so "in flight" is deterministic. */
function gatedApi() {
  const calls: RequestInit[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    await gate;
    return new Response(JSON.stringify({ balance: 42 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, open, fetchImpl };
}

async function start(opts: Partial<McpHttpOptions>): Promise<string> {
  server = createMcpHttpServer({ mcpPath: '/mcp', allowedHosts: [], allowedOrigins: [], rateLimitPerMinute: 1000, ...opts });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', selectkey: 'sk_test_abc', ...headers },
    body: JSON.stringify(body),
  });
const balance = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'call_api', arguments: { operationId: 'getBalance' } } });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('the hosted HTTP host under abuse', () => {
  it('refuses a JSON-RPC batch before running any of it', async () => {
    const api = gatedApi();
    api.open();
    const base = await start({ fetchImpl: api.fetchImpl });
    const res = await post(base, [balance(1), balance(2)]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect(api.calls).toHaveLength(0);
  });

  it('bounds the requests one client holds at once (429), and frees the slot when the answer closes', async () => {
    const api = gatedApi();
    const base = await start({ fetchImpl: api.fetchImpl, maxInFlightPerIp: 2, maxInFlight: 10 });
    const first = [post(base, balance(1)), post(base, balance(2))];
    await until(() => api.calls.length === 2);
    const third = await post(base, balance(3));
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('1');
    api.open();
    for (const res of await Promise.all(first)) {
      expect(res.status).toBe(200);
      await res.text();
    }
    await until(() => true);
    const again = await post(base, balance(4));
    expect(again.status).toBe(200);
    await again.text();
  });

  it('bounds the total held by everyone (503), whatever the client', async () => {
    const api = gatedApi();
    const base = await start({ fetchImpl: api.fetchImpl, maxInFlightPerIp: 5, maxInFlight: 2 });
    const first = [post(base, balance(1)), post(base, balance(2))];
    await until(() => api.calls.length === 2);
    const third = await post(base, balance(3));
    expect(third.status).toBe(503);
    api.open();
    for (const res of await Promise.all(first)) await res.text();
  });

  it('calls the API without following redirects (the selectkey must not travel to another host)', async () => {
    const api = gatedApi();
    api.open();
    const base = await start({ fetchImpl: api.fetchImpl });
    const res = await post(base, balance(1));
    await res.text();
    expect(api.calls[0]!.redirect).toBe('error');
  });
});

describe('the multi-MB resources are local-only', () => {
  const resourceNames = async (hosted: boolean) => {
    const srv = createServer(configFromEnv({ hosted, selectKey: 'sk_test_x' }));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([srv.connect(serverT), client.connect(clientT)]);
    return client.listResources().then((r) => r.resources.map((x) => x.name).sort(), () => []);
  };

  it('the hosted server serves neither the whole spec nor the whole corpus', async () => {
    expect(await resourceNames(true)).toEqual([]);
  });

  it('the local server still does', async () => {
    const saved = process.env.MCP_HOSTED;
    process.env.MCP_HOSTED = 'false';
    try {
      expect(await resourceNames(false)).toEqual(['llms', 'openapi']);
    } finally {
      process.env.MCP_HOSTED = saved;
    }
  });
});

describe('guards', () => {
  it('rateKey: IPv4 as is, IPv6 by its /64 (one client cannot rotate addresses inside its own prefix)', () => {
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(rateKey('2001:0db8:00aa:00bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(rateKey('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe(rateKey('2001:db8:aa:bb::2'));
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('a release is counted once', () => {
    const limiter = createInFlightLimiter(1, 1);
    const a = limiter.acquire('k');
    expect(a.ok).toBe(true);
    expect(limiter.acquire('k')).toEqual({ ok: false, reason: 'total' });
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(limiter.inFlight()).toBe(0);
    expect(limiter.acquire('k').ok).toBe(true);
  });

  it('a knob that is not a positive integer stops the boot instead of turning the limit off', () => {
    expect(positiveIntEnv('X', undefined, 120)).toBe(120);
    expect(positiveIntEnv('X', '30', 120)).toBe(30);
    for (const bad of ['abc', '0', '-5', '1.5']) expect(() => positiveIntEnv('X', bad, 120)).toThrow(/positive integer/);
    expect(() => createRateLimiter(Number.NaN)).toThrow(/positive/);
  });
});
