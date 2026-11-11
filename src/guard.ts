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

/**
 * The bucket a client IP counts against: the address itself for IPv4, its /64 for IPv6 — one IPv6 client holds a whole
 * /64 and could otherwise wear a new address per request, past every per-IP limit (security sweep 31, MCP-3).
 */
export function rateKey(ip: string): string {
  const addr = ip.replace(/%.*$/, '').toLowerCase();
  if (!addr.includes(':')) return addr;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Requests in flight, per client and in total, held until the RESPONSE closes (not when the handler returns: a client
 * that does not read keeps its response in this process's memory). The per-minute limit counts arrivals; this bounds
 * what is held at once — a burst or a slow reader can no longer stack responses until the container runs out of
 * memory (security sweep 31, MCP-1).
 */
export function createInFlightLimiter(perKey: number, total: number) {
  const byKey = new Map<string, number>();
  let all = 0;
  return {
    /** A release function (idempotent), or why the request may not start. */
    acquire(key: string): { ok: true; release: () => void } | { ok: false; reason: 'per-key' | 'total' } {
      if (all >= total) return { ok: false, reason: 'total' };
      const mine = byKey.get(key) ?? 0;
      if (mine >= perKey) return { ok: false, reason: 'per-key' };
      byKey.set(key, mine + 1);
      all += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          all -= 1;
          const left = (byKey.get(key) ?? 1) - 1;
          if (left > 0) byKey.set(key, left);
          else byKey.delete(key);
        },
      };
    },
    inFlight: (): number => all,
  };
}

/**
 * A positive integer from the environment, or the default when unset. Anything else stops the boot: `Number('abc')`
 * is NaN, and `count > NaN` is never true — a typo in the knob used to turn the rate limit OFF in silence.
 */
export function positiveIntEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got '${value}'`);
  return n;
}

/** A fixed-window counter per key, in memory — the hosted server runs one replica. */
export function createRateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now) {
  if (!(Number.isFinite(limit) && limit >= 1)) throw new Error(`rate limit must be a positive number, got ${limit}`);
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
