/**
 * OAuth on the hosted server — this MCP server is an OAuth 2.1 RESOURCE server (MCP authorization spec):
 *   - it publishes its Protected Resource Metadata (RFC 9728), naming the Selectwin authorization server;
 *   - a client (claude.ai, Claude Code, ChatGPT) signs the seller in there and sends `Authorization: Bearer <token>`,
 *     a token whose audience is THIS server (RFC 8707);
 *   - this server never forwards that token (the spec forbids passing it through): it trades it at the authorization
 *     server for the same session's API token (RFC 8693 token exchange), with its own confidential client credentials,
 *     and calls the API with that. The trade also validates the client's token — signature, audience, live session,
 *     the `mcp:read` scope — so a token the authorization server refuses becomes a 401 here.
 */
import { createHash } from 'node:crypto';

export const MCP_READ_SCOPE = 'mcp:read';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const EXCHANGE_TIMEOUT_MS = 10_000;
/** Trade again this long before the API token expires, so a call never leaves with a token about to die. */
const EXPIRY_MARGIN_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;

export interface OAuthResourceConfig {
  /** The authorization server's issuer — what the metadata names and where `/token` lives. */
  issuer: string;
  /** This server's canonical URI (RFC 8707): the PRM `resource`, exactly what the user enters in the client. */
  resource: string;
}

export interface ExchangeCredentials {
  clientId: string;
  clientSecret: string;
}

/** RFC 9728 Protected Resource Metadata. */
export function protectedResourceMetadata(oauth: OAuthResourceConfig): Record<string, unknown> {
  return {
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: [MCP_READ_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Selectwin',
    resource_documentation: 'https://selectwin.io/docs/sdk/mcp/overview',
  };
}

/** Where this server serves its PRM: `/.well-known/oauth-protected-resource{mcpPath}` (the spec's first probe). */
export function protectedResourceMetadataUrl(oauth: OAuthResourceConfig, mcpPath: string): string {
  return `${new URL(oauth.resource).origin}/.well-known/oauth-protected-resource${mcpPath}`;
}

/** The 401 challenge (RFC 6750 §3 + RFC 9728 §5.1): it points the client at the PRM and asks for `mcp:read`. */
export function bearerChallenge(oauth: OAuthResourceConfig, mcpPath: string, description: string): string {
  const esc = (s: string) => s.replace(/["\\]/g, '');
  return `Bearer error="invalid_token", error_description="${esc(description)}", resource_metadata="${protectedResourceMetadataUrl(oauth, mcpPath)}", scope="${MCP_READ_SCOPE}"`;
}

export type ExchangeResult =
  | { ok: true; token: string }
  /** `rejected`: the authorization server refused the client's token (→ 401 to the client). `unavailable`: it could not answer. */
  | { ok: false; kind: 'rejected' | 'unavailable'; detail: string };

/**
 * The RFC 8693 client, with a small cache keyed by the client token's hash: one trade per client token until the API
 * token is close to expiring (the authorization server issues it with the client token's remaining life, ≤ 1 h).
 */
export function createTokenExchanger(
  oauth: OAuthResourceConfig,
  credentials: ExchangeCredentials,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`).toString('base64')}`;

  function sweep(): void {
    const t = now();
    for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
    // Still too big: drop the oldest entries (Map keeps insertion order).
    while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }

  return {
    async exchange(subjectToken: string): Promise<ExchangeResult> {
      const key = createHash('sha256').update(subjectToken).digest('hex');
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return { ok: true, token: hit.token };

      let res: Response;
      try {
        res = await doFetch(`${oauth.issuer}/token`, {
          method: 'POST',
          headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            subject_token: subjectToken,
            subject_token_type: ACCESS_TOKEN_TYPE,
            requested_token_type: ACCESS_TOKEN_TYPE,
            audience: 'api',
          }).toString(),
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        });
      } catch (e) {
        return { ok: false, kind: 'unavailable', detail: (e as Error).name };
      }
      const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
      if (res.ok && typeof body?.access_token === 'string') {
        const ttlMs = (typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300) * 1000;
        sweep();
        cache.set(key, { token: body.access_token, expiresAt: now() + Math.max(0, ttlMs - EXPIRY_MARGIN_MS) });
        return { ok: true, token: body.access_token };
      }
      const error = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
      // `invalid_grant`/`invalid_scope`/`invalid_target`: the client's token is not good here. A refusal of OUR client
      // (`invalid_client`, `unauthorized_client`) or a 5xx is ours to fix, not the user's — it must not loop them through
      // sign-in again, so it is `unavailable`.
      const rejected = res.status === 400 && ['invalid_grant', 'invalid_scope', 'invalid_target', 'invalid_request'].includes(error);
      return { ok: false, kind: rejected ? 'rejected' : 'unavailable', detail: error };
    },
    size: (): number => cache.size,
  };
}

export type TokenExchanger = ReturnType<typeof createTokenExchanger>;
