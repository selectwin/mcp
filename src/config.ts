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
  /** Allow financial mutations (transactions/withdrawals/refund/dispute/capture). Off by default. */
  enableFinancialWrites: boolean;
  userAgent: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export const MCP_VERSION = '0.1.0';

const strip = (u: string) => u.replace(/\/+$/, '');

export function configFromEnv(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    docsUrl: strip(process.env.SELECTWIN_DOCS_URL || 'https://docs.selectwin.io'),
    apiUrl: strip(process.env.SELECTWIN_API_URL || 'https://api.selectwin.io'),
    selectKey: process.env.SELECTWIN_API_KEY || undefined,
    enableWrites: process.env.MCP_ENABLE_WRITES === 'true',
    enableFinancialWrites: process.env.MCP_ENABLE_FINANCIAL_WRITES === 'true',
    userAgent: `selectwin-mcp/${MCP_VERSION}`,
    ...overrides,
  };
}
