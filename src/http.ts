/**
 * Streamable HTTP host for the Selectwin MCP server (stateless).
 *
 * Each request builds a fresh server so its tools close over that request's SelectKey. The guards in `guard.ts` run
 * first: Host and Origin, a per-IP rate limit and a body cap. Logs go to stderr, one JSON line per MCP request, and
 * never include the key.
 */
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_VERSION, configFromEnv } from './config.js';
import { createServer } from './server.js';
import { clientIp, createRateLimiter, csv, hostAllowed, keyKind, originAllowed, readBody, selectKeyOf } from './guard.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const ALLOWED_HOSTS = csv(process.env.MCP_ALLOWED_HOSTS);
const ALLOWED_ORIGINS = csv(process.env.MCP_ALLOWED_ORIGINS);
const CLIENT_IP_HEADER = process.env.MCP_CLIENT_IP_HEADER || undefined;
const RATE_LIMIT_PER_MIN = Number(process.env.MCP_RATE_LIMIT_PER_MIN || 120);
const MAX_BODY_BYTES = 1_000_000;

const limiter = createRateLimiter(RATE_LIMIT_PER_MIN);
setInterval(() => limiter.sweep(), 60_000).unref();

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/** What the access log may say about a JSON-RPC message: the method, and for a tool call its name and operationId. */
function describe(body: unknown): { rpc?: string; tool?: string; op?: string } {
  if (Array.isArray(body)) return { rpc: 'batch' };
  if (!body || typeof body !== 'object') return {};
  const msg = body as { method?: unknown; params?: { name?: unknown; arguments?: { operationId?: unknown } } };
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  return { rpc: str(msg.method), tool: str(msg.params?.name), op: str(msg.params?.arguments?.operationId) };
}

const http = createHttpServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) {
    json(res, 403, { error: 'host_not_allowed' });
    return;
  }
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(
      `Selectwin MCP ${MCP_VERSION}\n\nStreamable HTTP endpoint: ${MCP_PATH}\nAuth: the \`selectkey\` header with your SelectKey.\nDocs: https://selectwin.io/docs\n`,
    );
    return;
  }
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const ip = clientIp(req, CLIENT_IP_HEADER);
  const selectKey = selectKeyOf(req);
  let logged: ReturnType<typeof describe> = {};
  res.on('finish', () => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'mcp',
        ip,
        method: req.method,
        status: res.statusCode,
        ms: Date.now() - started,
        key: keyKind(selectKey),
        ...logged,
      }),
    );
  });

  if (!originAllowed(req.headers.origin, ALLOWED_ORIGINS)) {
    json(res, 403, rpcError(-32000, 'Origin not allowed'));
    return;
  }
  // Stateless: no session to push notifications to, so no standalone SSE stream (GET) and nothing to end (DELETE).
  // Left to the transport, a GET held an idle stream open with no deadline — one per request, a way to pile up sockets.
  if (req.method !== 'POST') {
    json(res, 405, rpcError(-32000, 'Method not allowed: this server is stateless, use POST'), { Allow: 'POST' });
    return;
  }
  const quota = limiter.take(ip);
  if (!quota.ok) {
    json(res, 429, rpcError(-32000, 'Too many requests'), { 'Retry-After': String(quota.retryAfterSec) });
    return;
  }

  const read = await readBody(req, MAX_BODY_BYTES);
  if (!read.ok) {
    json(res, 413, rpcError(-32000, 'Request body too large'), { Connection: 'close' });
    req.destroy();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(read.raw);
  } catch {
    json(res, 400, rpcError(-32700, 'Parse error'));
    return;
  }
  logged = describe(body);

  const server = createServer(configFromEnv({ selectKey }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) json(res, 500, rpcError(-32603, 'Internal server error'));
  }
});

// Behind the edge's reverse proxy: keep idle connections longer than the proxy does, so it never reuses one this
// side already closed (the classic intermittent 502).
http.keepAliveTimeout = 75_000;
http.headersTimeout = 76_000;
http.requestTimeout = 65_000;

http.listen(PORT, () => {
  // stderr only — keep stdout clean.
  console.error(`Selectwin MCP ${MCP_VERSION} (Streamable HTTP${configFromEnv().hosted ? ', hosted' : ''}) listening on :${PORT}${MCP_PATH}`);
});

const shutdown = () => {
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
