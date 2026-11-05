/** Runtime configuration for the Selectwin MCP server. */
export interface ServerConfig {
  /** Public docs site base URL (for the docs tools). */
  docsUrl: string;
  /** Selectwin API base URL (host-locked target for the API tools). */
  apiUrl: string;
  /** The caller's SelectKey — per-request over HTTP, or from env over stdio. */
  selectKey?: string;
  /** Allow non-GET (mutating) API calls. Off by default. */
  enableWrites: boolean;
  /**
   * Allow financial/SENSITIVE mutations: money (transactions, withdrawals, refund, dispute, capture, checkout pay),
   * subscriptions and splits, coupons, cards, wallets, webhooks, price edits, deletes — every write outside the standard
   * allowlist in `spec.ts`. Off by default.
   */
  enableFinancialWrites: boolean;
  /**
   * The public multi-tenant deployment (mcp.selectwin.io): read-only, and `call_api` runs only `HOSTED_READS`.
   * It overrides the write flags — no environment variable turns writes on for the hosted server.
   */
  hosted: boolean;
  /**
   * The caller's API token when it signed in with OAuth (hosted): what the RFC 8693 exchange returned for its token.
   * Used instead of the SelectKey; never the client's own token (the MCP spec forbids passing that one through).
   */
  apiToken?: string;
  /** OAuth on (hosted, with exchange credentials): the tools declare their security schemes. */
  oauth?: { issuer: string; resource: string };
  userAgent: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

declare const __MCP_VERSION__: string | undefined;
/**
 * Server version — injected at build from package.json (the single source of
 * truth), so the User-Agent can never drift from the published version. Falls
 * back to `0.0.0-dev` when run unbundled without the define.
 */
export const MCP_VERSION: string =
  typeof __MCP_VERSION__ === 'string' ? __MCP_VERSION__ : '0.0.0-dev';

const strip = (u: string) => u.replace(/\/+$/, '');

export function configFromEnv(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const config: ServerConfig = {
    docsUrl: strip(process.env.SELECTWIN_DOCS_URL || 'https://selectwin.io'),
    apiUrl: strip(process.env.SELECTWIN_API_URL || 'https://api.selectwin.io'),
    selectKey: process.env.SELECTWIN_API_KEY || undefined,
    enableWrites: process.env.MCP_ENABLE_WRITES === 'true',
    enableFinancialWrites: process.env.MCP_ENABLE_FINANCIAL_WRITES === 'true',
    hosted: process.env.MCP_HOSTED === 'true',
    userAgent: `selectwin-mcp/${MCP_VERSION}`,
    ...overrides,
  };
  // The hosted server never writes, whatever the flags say.
  if (config.hosted) return { ...config, enableWrites: false, enableFinancialWrites: false };
  return config;
}
