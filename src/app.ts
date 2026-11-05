/**
 * The Streamable HTTP host of the Selectwin MCP server (stateless), as a factory: `createMcpHttpServer(options)` builds
 * the `http.Server` without listening, so it is tested end to end; `http.ts` reads the environment and listens.
 *
 * Each request builds a fresh MCP server whose tools close over that request's credential:
 *   - a SelectKey (`selectkey` header, or `Authorization: Bearer sk_…`);
 *   - an OAuth token (`Authorization: Bearer <token>`, hosted): traded at the authorization server for the same session's
 *     API token (`oauth.ts`) — never forwarded;
 *   - nothing: the docs tools still work (lazy authentication); a call to `call_api` answers HTTP 401 with the
 *     `WWW-Authenticate` challenge, which is what makes Claude show "Connect" and retry the call after sign-in.
 *
 * The guards in `guard.ts` run first: Host and Origin, a per-IP rate limit and a body cap. Logs go to stderr, one JSON
 * line per MCP request, and never include a key or a token.
 */
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_VERSION, configFromEnv } from './config.js';
import { createServer } from './server.js';
import { bearerOf, clientIp, createRateLimiter, hostAllowed, keyKind, needsAccount, originAllowed, readBody, selectKeyOf } from './guard.js';
import { bearerChallenge, protectedResourceMetadata, type OAuthResourceConfig, type TokenExchanger } from './oauth.js';

const MAX_BODY_BYTES = 1_000_000;

export interface McpHttpOptions {
  mcpPath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  clientIpHeader?: string;
  rateLimitPerMinute: number;
  /** OAuth on (hosted): this server's resource config and the RFC 8693 client. Absent ⇒ SelectKey only. */
  oauth?: { resource: OAuthResourceConfig; exchanger: TokenExchanger };
  /** Injectable fetch for the API/docs calls (tests). */
  fetchImpl?: typeof fetch;
}

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

export function createMcpHttpServer(options: McpHttpOptions): Server {
  const limiter = createRateLimiter(options.rateLimitPerMinute);
  const sweeper = setInterval(() => limiter.sweep(), 60_000);
  sweeper.unref();
  const prmPaths = new Set(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${options.mcpPath}`]);

  const http = createHttpServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (!hostAllowed(req.headers.host, options.allowedHosts)) {
      json(res, 403, { error: 'host_not_allowed' });
      return;
    }
    // RFC 9728 Protected Resource Metadata: public, cacheable, readable from a browser-based client.
    if (options.oauth && prmPaths.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      json(res, 200, protectedResourceMetadata(options.oauth.resource), { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(
        `Selectwin MCP ${MCP_VERSION}\n\nStreamable HTTP endpoint: ${options.mcpPath}\nAuth: sign in (OAuth) from your MCP client, or the \`selectkey\` header with your SelectKey.\nDocs: https://selectwin.io/docs/sdk/mcp/overview\n`,
      );
      return;
    }
    if (url.pathname !== options.mcpPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const ip = clientIp(req, options.clientIpHeader);
    const selectKey = selectKeyOf(req);
    const bearer = options.oauth ? bearerOf(req) : undefined;
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
          key: bearer ? 'oauth' : keyKind(selectKey),
          ...logged,
        }),
      );
    });

    if (!originAllowed(req.headers.origin, options.allowedOrigins)) {
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

    // OAuth: the client's token buys the session's API token; a refused token is a 401 like a missing one.
    let apiToken: string | undefined;
    if (options.oauth && bearer) {
      const traded = await options.oauth.exchanger.exchange(bearer);
      if (!traded.ok) {
        if (traded.kind === 'unavailable') {
          json(res, 503, rpcError(-32000, 'Sign-in is temporarily unavailable. Try again in a moment.'), { 'Retry-After': '5' });
          return;
        }
        challenge(res, options, 'The access token is invalid or expired');
        return;
      }
      apiToken = traded.token;
    }
    // Lazy authentication: only a call that needs the account requires a credential (Claude signs in on this 401).
    if (options.oauth && !apiToken && !selectKey && needsAccount(body)) {
      challenge(res, options, 'Sign in to Selectwin to use this tool');
      return;
    }

    const server = createServer(
      configFromEnv({
        selectKey: apiToken ? undefined : selectKey,
        apiToken,
        ...(options.oauth ? { oauth: { issuer: options.oauth.resource.issuer, resource: options.oauth.resource.resource } } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
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
  http.on('close', () => clearInterval(sweeper));
  return http;
}

/** HTTP 401 + `WWW-Authenticate` (RFC 6750/9728) before the SDK runs — a 200 tool error never triggers sign-in. */
function challenge(res: ServerResponse, options: McpHttpOptions, description: string): void {
  json(res, 401, { error: 'invalid_token', error_description: description }, { 'WWW-Authenticate': bearerChallenge(options.oauth!.resource, options.mcpPath, description) });
}
