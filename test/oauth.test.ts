import { describe, it, expect } from 'vitest';
import { bearerChallenge, createTokenExchanger, protectedResourceMetadata, protectedResourceMetadataUrl } from '../src/oauth';

const resource = { issuer: 'https://api.selectwin.io/v1/authentication/oauth', resource: 'https://mcp.selectwin.io/mcp' };
const creds = { clientId: 'oac_mcp', clientSecret: 'oas_secret' };

function tokenEndpoint(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, reply };
}

describe('protected resource metadata (RFC 9728)', () => {
  it('names this resource, the Selectwin authorization server and mcp:read', () => {
    expect(protectedResourceMetadata(resource)).toMatchObject({
      resource: 'https://mcp.selectwin.io/mcp',
      authorization_servers: ['https://api.selectwin.io/v1/authentication/oauth'],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
    });
    expect(protectedResourceMetadataUrl(resource, '/mcp')).toBe('https://mcp.selectwin.io/.well-known/oauth-protected-resource/mcp');
  });

  it('the 401 challenge points at the metadata and asks for mcp:read', () => {
    expect(bearerChallenge(resource, '/mcp', 'Sign in')).toBe(
      'Bearer error="invalid_token", error_description="Sign in", resource_metadata="https://mcp.selectwin.io/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
    );
  });
});

describe('token exchange client (RFC 8693)', () => {
  it('trades with Basic credentials and the RFC form, then serves the cache until near expiry', async () => {
    let t = 1_000_000;
    const ep = tokenEndpoint({ status: 200, body: { access_token: 'api-token-1', expires_in: 3600, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } });
    const ex = createTokenExchanger(resource, creds, { fetchImpl: ep.fetchImpl, now: () => t });
    expect(await ex.exchange('client-token')).toEqual({ ok: true, token: 'api-token-1' });
    expect(ep.calls[0]!.url).toBe('https://api.selectwin.io/v1/authentication/oauth/token');
    const headers = ep.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('oac_mcp:oas_secret').toString('base64')}`);
    const form = new URLSearchParams(String(ep.calls[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'client-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'api',
    });
    // Cached: no second call for the same client token…
    expect(await ex.exchange('client-token')).toEqual({ ok: true, token: 'api-token-1' });
    expect(ep.calls).toHaveLength(1);
    // …until 30 s before the API token expires.
    t += 3600_000 - 29_000;
    await ex.exchange('client-token');
    expect(ep.calls).toHaveLength(2);
  });

  it('a token the authorization server refuses is `rejected` (→ 401); our own problem is `unavailable` (→ 503)', async () => {
    for (const [status, error, kind] of [
      [400, 'invalid_grant', 'rejected'],
      [400, 'invalid_scope', 'rejected'],
      [401, 'invalid_client', 'unavailable'],
      [400, 'unauthorized_client', 'unavailable'],
      [503, 'server_error', 'unavailable'],
    ] as const) {
      const ep = tokenEndpoint({ status, body: { error } });
      const ex = createTokenExchanger(resource, creds, { fetchImpl: ep.fetchImpl });
      expect(await ex.exchange('t'), error).toEqual({ ok: false, kind, detail: error });
      expect(ex.size()).toBe(0);
    }
    const down = createTokenExchanger(resource, creds, { fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    expect(await down.exchange('t')).toEqual({ ok: false, kind: 'unavailable', detail: 'TypeError' });
  });
});
