/**
 * Streamable HTTP host for the Selectwin MCP server — reads the environment and listens (`app.ts` builds the server).
 *
 * OAuth (hosted) turns on when the exchange credentials are present: `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET`
 * (the confidential client the authorization server lets trade tokens), with `MCP_RESOURCE_URL` (this server's
 * canonical URI) and `SELECTWIN_OAUTH_ISSUER` (the authorization server). Without them, SelectKey only.
 */
import { MCP_VERSION, configFromEnv } from './config.js';
import { csv } from './guard.js';
import { createMcpHttpServer } from './app.js';
import { createTokenExchanger, type OAuthResourceConfig } from './oauth.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const env = configFromEnv();

const clientId = process.env.MCP_OAUTH_CLIENT_ID;
const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
const resource: OAuthResourceConfig = {
  issuer: (process.env.SELECTWIN_OAUTH_ISSUER || `${env.apiUrl}/v1/authentication/oauth`).replace(/\/+$/, ''),
  resource: process.env.MCP_RESOURCE_URL || 'https://mcp.selectwin.io/mcp',
};
const oauth = clientId && clientSecret ? { resource, exchanger: createTokenExchanger(resource, { clientId, clientSecret }) } : undefined;

const http = createMcpHttpServer({
  mcpPath: MCP_PATH,
  allowedHosts: csv(process.env.MCP_ALLOWED_HOSTS),
  allowedOrigins: csv(process.env.MCP_ALLOWED_ORIGINS),
  clientIpHeader: process.env.MCP_CLIENT_IP_HEADER || undefined,
  rateLimitPerMinute: Number(process.env.MCP_RATE_LIMIT_PER_MIN || 120),
  oauth,
});

http.listen(PORT, () => {
  // stderr only — keep stdout clean.
  const mode = [env.hosted ? 'hosted' : null, oauth ? 'oauth' : null].filter(Boolean).join(', ');
  console.error(`Selectwin MCP ${MCP_VERSION} (Streamable HTTP${mode ? `, ${mode}` : ''}) listening on :${PORT}${MCP_PATH}`);
});

const shutdown = () => {
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
