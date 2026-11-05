import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, it, expect } from 'vitest';
import { clientIp, createRateLimiter, csv, hostAllowed, keyKind, originAllowed, readBody, selectKeyOf } from '../src/guard';

const req = (headers: Record<string, string>, remoteAddress = '10.0.0.2') =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('guards', () => {
  it('parses env lists', () => {
    expect(csv(' mcp.selectwin.io, MCP.example.com ,,')).toEqual(['mcp.selectwin.io', 'mcp.example.com']);
    expect(csv(undefined)).toEqual([]);
  });

  it('checks the Host header (port ignored); an empty list accepts any', () => {
    expect(hostAllowed('mcp.selectwin.io', ['mcp.selectwin.io'])).toBe(true);
    expect(hostAllowed('MCP.selectwin.io:443', ['mcp.selectwin.io'])).toBe(true);
    expect(hostAllowed('evil.example', ['mcp.selectwin.io'])).toBe(false);
    expect(hostAllowed(undefined, ['mcp.selectwin.io'])).toBe(false);
    expect(hostAllowed('localhost:3000', [])).toBe(true);
  });

  it('lets a request without Origin through; one with an Origin only when listed', () => {
    expect(originAllowed(undefined, [])).toBe(true);
    expect(originAllowed('https://evil.example', [])).toBe(false);
    expect(originAllowed('http://localhost:6274', ['http://localhost:6274'])).toBe(true);
  });

  it('takes the client IP from the configured edge header, else the socket', () => {
    expect(clientIp(req({ 'x-cabber-ip': '203.0.113.7' }), 'X-Cabber-IP')).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.8, 10.0.0.2' }), 'x-forwarded-for')).toBe('203.0.113.8');
    expect(clientIp(req({}), 'x-cabber-ip')).toBe('10.0.0.2');
    expect(clientIp(req({ 'x-cabber-ip': '203.0.113.7' }))).toBe('10.0.0.2');
  });

  it('reads the SelectKey from `selectkey` or an sk_ bearer — never another bearer', () => {
    expect(selectKeyOf(req({ selectkey: 'sk_live_abc' }))).toBe('sk_live_abc');
    expect(selectKeyOf(req({ authorization: 'Bearer sk_test_abc' }))).toBe('sk_test_abc');
    expect(selectKeyOf(req({ authorization: 'Bearer eyJhbGciOi.jwt' }))).toBeUndefined();
    expect(selectKeyOf(req({}))).toBeUndefined();
    expect(keyKind('sk_live_x')).toBe('live');
    expect(keyKind('sk_test_x')).toBe('test');
    expect(keyKind('whatever')).toBe('other');
    expect(keyKind(undefined)).toBe('none');
  });

  it('rate-limits per key in a fixed window and forgets ended windows', () => {
    let t = 0;
    const limiter = createRateLimiter(2, 60_000, () => t);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    const third = limiter.take('a');
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.retryAfterSec).toBe(60);
    expect(limiter.take('b').ok).toBe(true);
    t = 60_000;
    expect(limiter.take('a').ok).toBe(true);
    t = 200_000;
    limiter.sweep();
    expect(limiter.size()).toBe(0);
  });

  it('caps the body: by Content-Length up front, and while streaming', async () => {
    const stream = (chunks: string[], headers: Record<string, string> = {}) =>
      Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { headers }) as unknown as IncomingMessage;
    expect(await readBody(stream(['{"a":1}']), 100)).toEqual({ ok: true, raw: '{"a":1}' });
    expect(await readBody(stream(['x'], { 'content-length': '5000' }), 100)).toEqual({ ok: false, status: 413 });
    expect(await readBody(stream(['x'.repeat(60), 'y'.repeat(60)]), 100)).toEqual({ ok: false, status: 413 });
  });
});
