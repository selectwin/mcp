/**
 * The HTTP host's request guards — pure, so they are unit-tested apart from the socket: Host and Origin checks (the
 * MCP spec requires validating Origin on Streamable HTTP, against DNS rebinding), a per-IP rate limit, the body cap,
 * and where the caller's SelectKey comes from.
 */
import type { IncomingMessage } from 'node:http';

/** A comma-separated env list, lower-cased (`MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`). */
export function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The Host header against the allowlist, port ignored. An empty list accepts any host (local runs). */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (!host) return false;
  return allowed.includes(host.toLowerCase().replace(/:\d+$/, ''));
}

/**
 * MCP clients are programs, not web pages, so they send no Origin. A request that carries one came from a browser
 * and passes only when that origin is listed.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin.toLowerCase());
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * The client IP: the header the edge writes (`MCP_CLIENT_IP_HEADER`, e.g. the Cabber edge's `x-cabber-ip`) when
 * configured, else the socket peer. Behind the Swarm ingress the peer is always the internal hop, so the header is
 * what tells callers apart.
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, header?: string): string {
  if (header) {
    const value = first(req.headers[header.toLowerCase()]);
    const ip = value?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * The caller's SelectKey: the `selectkey` header, or `Authorization: Bearer sk_…` for clients that can only send a
 * bearer token (e.g. API-side MCP connectors). Only an `sk_` bearer counts — any other bearer is not a SelectKey.
 */
export function selectKeyOf(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const header = first(req.headers['selectkey'])?.trim();
  if (header) return header;
  const auth = first(req.headers['authorization'])?.trim();
  const match = auth?.match(/^Bearer\s+(sk_\S+)$/i);
  return match?.[1];
}

/**
 * An OAuth access token: `Authorization: Bearer <anything but an sk_ key>`. On the hosted server it is a token the
 * Selectwin authorization server issued for this MCP server (claude.ai, ChatGPT, Claude Code sign the seller in).
 */
export function bearerOf(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const auth = first(req.headers['authorization'])?.trim();
  const match = auth?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token && !/^sk_/i.test(token) ? token : undefined;
}

/** The tools that act on the seller's account — the ones that need a credential (lazy auth: the docs tools do not). */
const ACCOUNT_TOOLS: ReadonlySet<string> = new Set(['call_api']);

/** Does this JSON-RPC message (or batch) call a tool that needs the seller's account? */
export function needsAccount(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    if (!m || typeof m !== 'object') return false;
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    return msg.method === 'tools/call' && typeof msg.params?.name === 'string' && ACCOUNT_TOOLS.has(msg.params.name);
  });
}

/** Which environment a key targets, for the access log (never the key itself). */
export function keyKind(key: string | undefined): 'live' | 'test' | 'other' | 'none' {
  if (!key) return 'none';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'other';
}

/** A fixed-window counter per key, in memory — the hosted server runs one replica. */
export function createRateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; count: number }>();
  return {
    take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
      const t = now();
      let entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        entry = { start: t, count: 0 };
        hits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000)) };
      return { ok: true };
    },
    /** Forget the windows that ended (called on an interval, so the map does not grow with every IP ever seen). */
    sweep(): void {
      const t = now();
      for (const [key, entry] of hits) if (t - entry.start >= windowMs) hits.delete(key);
    },
    size: (): number => hits.size,
  };
}

export type BodyResult = { ok: true; raw: string } | { ok: false; status: 413 };

/** Read the request body up to `maxBytes`; past that the answer is 413 and the rest is not buffered. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) return Promise.resolve({ ok: false, status: 413 });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: true, raw: '' }));
  });
}
