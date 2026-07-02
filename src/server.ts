/**
 * The Selectwin MCP server — documentation tools (public, read-only) + an API
 * tool (SelectKey-authed, write-gated). Build one per request (HTTP, so tools
 * close over that request's SelectKey) or once from env (stdio).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_VERSION, type ServerConfig } from './config.js';
import { searchDocs, getLlmsTxt } from './docs.js';
import { apiReferenceSummary, spec } from './spec.js';
import { ApiToolError, callApi } from './api.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });
const errorText = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: 'selectwin', version: MCP_VERSION });

  // --- Documentation tools (Phase 1, public) -------------------------------
  server.registerTool(
    'search_docs',
    {
      title: 'Search Selectwin docs',
      description:
        'Full-text search across the Selectwin documentation and API reference. Returns matching pages with links.',
      inputSchema: {
        query: z.string().min(1).describe('What to look for, e.g. "create a PIX transaction".'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
      },
    },
    async ({ query, limit }) => {
      try {
        return text(await searchDocs(config, query, limit ?? 10));
      } catch (e) {
        return errorText(`search_docs failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_llms_txt',
    {
      title: 'Get the docs corpus (llms.txt)',
      description:
        'Fetch the Selectwin docs as plain text. `full: true` returns the complete corpus (llms-full.txt); otherwise the index (llms.txt).',
      inputSchema: {
        full: z.boolean().optional().describe('Return the full corpus instead of the index.'),
      },
    },
    async ({ full }) => {
      try {
        return text(await getLlmsTxt(config, full ?? false));
      } catch (e) {
        return errorText(`get_llms_txt failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'list_api_reference',
    {
      title: 'List Selectwin API operations',
      description:
        'List every Selectwin API operation (operationId, method, path, summary) grouped by resource. Use an operationId with `call_api`.',
      inputSchema: {},
    },
    async () => text(apiReferenceSummary()),
  );

  server.registerTool(
    'get_openapi',
    {
      title: 'Get the OpenAPI spec',
      description: 'Return the Selectwin OpenAPI (v2.0.0) document as JSON.',
      inputSchema: {},
    },
    async () => text(JSON.stringify(spec)),
  );

  // --- API tool (Phase 2+, SelectKey-authed, write-gated) ------------------
  server.registerTool(
    'call_api',
    {
      title: 'Call the Selectwin API',
      description:
        'Execute a Selectwin API operation by operationId (see list_api_reference). Reads work with a SelectKey; ' +
        'writes require MCP_ENABLE_WRITES and financial writes require MCP_ENABLE_FINANCIAL_WRITES. ' +
        'The environment (sandbox/production) is decided by the key prefix (sk_test_ / sk_live_).',
      inputSchema: {
        operationId: z.string().min(1).describe('e.g. "getBalance", "listTransactions", "createCustomer".'),
        pathParams: z.record(z.string()).optional().describe('Path params, e.g. { "customerId": "cus_..." }.'),
        query: z.record(z.any()).optional().describe('Query params, e.g. { "limit": 20 }.'),
        body: z.record(z.any()).optional().describe('JSON request body for writes.'),
        idempotencyKey: z.string().optional().describe('Override the auto X-Idempotency-Key on writes.'),
      },
    },
    async (input) => {
      try {
        const result = await callApi(config, input);
        const rendered = `HTTP ${result.status}\n\n${JSON.stringify(result.body, null, 2)}`;
        return result.ok ? text(rendered) : errorText(rendered);
      } catch (e) {
        if (e instanceof ApiToolError) return errorText(e.message);
        return errorText(`call_api failed: ${(e as Error).message}`);
      }
    },
  );

  // --- Resources -----------------------------------------------------------
  server.registerResource(
    'openapi',
    'selectwin://openapi.json',
    { title: 'Selectwin OpenAPI', description: 'The Selectwin OpenAPI v2.0.0 document.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(spec) }] }),
  );

  server.registerResource(
    'llms',
    'selectwin://llms.txt',
    { title: 'Selectwin docs (llms-full.txt)', description: 'The full Selectwin docs corpus as text.', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: await getLlmsTxt(config, true) }] }),
  );

  return server;
}
