/**
 * Streamable HTTP host for the Selectwin MCP server (stateless).
 *
 * Each request builds a fresh server so its tools close over that request's
 * `selectkey` header. Logs go to stderr and never include the key.
 */
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configFromEnv } from './config.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const header = req.headers['selectkey'];
  const selectKey = Array.isArray(header) ? header[0] : header;
  const config = configFromEnv({ selectKey: selectKey || undefined });
  const server = createServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
      );
    }
  }
});

http.listen(PORT, () => {
  // stderr only — keep stdout clean.
  console.error(`Selectwin MCP (Streamable HTTP) listening on :${PORT}${MCP_PATH}`);
});
