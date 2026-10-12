# @selectwin/mcp

Official **Selectwin** MCP server — lets AI assistants (Claude Desktop, Cursor, Claude
Code, …) **read the Selectwin docs** and **operate the API** over the Model Context Protocol.

> Status: **early / work in progress** (`0.1.0`). Standalone server (Streamable HTTP + stdio).
> Documentation tools are public/read-only; API access is SelectKey-authed and write-gated.

## What it exposes

**Tools**
- `search_docs(query, limit?)` — full-text search over the docs + API reference.
- `get_llms_txt(full?)` — the docs corpus as text (`llms.txt` / `llms-full.txt`).
- `list_api_reference()` — every API operation (operationId, method, path) grouped by resource.
- `get_openapi()` — the OpenAPI v2.0.0 document.
- `call_api({ operationId, pathParams?, query?, body?, idempotencyKey? })` — execute an API
  operation. Reads work with a SelectKey; **writes require `MCP_ENABLE_WRITES`** and **financial
  writes require `MCP_ENABLE_FINANCIAL_WRITES`**.

**Resources** — `selectwin://openapi.json`, `selectwin://llms.txt`.

Auth is the `selectkey` header; the environment (sandbox/production) is decided by the key
prefix (`sk_test_` / `sk_live_`).

## Run

### Remote (Streamable HTTP)

```bash
npm install && npm run build
PORT=3000 MCP_ENABLE_WRITES=false node dist/http.js
# → Streamable HTTP endpoint at http://localhost:3000/mcp  (health at /health)
```

Add it in a client that supports remote MCP connectors (e.g. Claude Desktop → *Custom
Connector*): URL `https://<host>/mcp`, and set the `selectkey` header to your API key.

### Local (stdio)

```jsonc
// Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "selectwin": {
      "command": "npx",
      "args": ["-y", "@selectwin/mcp"],
      "env": { "SELECTWIN_API_KEY": "sk_test_…", "MCP_ENABLE_WRITES": "false" }
    }
  }
}
```

### Inspect

```bash
npx @modelcontextprotocol/inspector
# point it at http://localhost:3000/mcp (Streamable HTTP)
```

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `SELECTWIN_API_KEY` | — | SelectKey for stdio (HTTP takes it from the `selectkey` header) |
| `SELECTWIN_API_URL` | `https://api.selectwin.io` | API base (host-locked target) |
| `SELECTWIN_DOCS_URL` | `https://selectwin.io` | docs site used by the docs tools |
| `MCP_ENABLE_WRITES` | `false` | allow non-GET API calls |
| `MCP_ENABLE_FINANCIAL_WRITES` | `false` | allow financial/sensitive mutations — everything outside the standard write allowlist (see Safety) |
| `PORT` / `MCP_PATH` | `3000` / `/mcp` | HTTP host |

## Safety

- **Read-only by default.** Writes are gated behind `MCP_ENABLE_WRITES`, which alone allows ONLY a short allowlist
  of low-risk edits: create/update customers and addresses, create products and variants, build checkout sessions and
  payment links, validate a coupon, test a webhook. Everything else — money (transactions, withdrawals, refunds,
  captures, disputes, checkout pay), subscriptions and revenue splits, coupons, cards, wallets, webhook endpoints and
  secrets, product/variant edits (prices), every DELETE, and any operation added to the API later — is a
  financial/sensitive write behind a second flag (`MCP_ENABLE_FINANCIAL_WRITES`). Never enable it for an autonomous
  agent.
- **API responses are marked as untrusted data.** Names, descriptions and metadata come from buyers and merchants;
  the `call_api` output tells the model not to follow instructions inside it.
- **Host-locked.** API calls only ever go to the configured Selectwin API origin.
- **The SelectKey is never logged.** An `X-Idempotency-Key` is added to every write.
- No polling loops — the docs steer assistants toward webhooks.

## Architecture

```
src/
  server.ts   # createServer(config) — registers all tools + resources
  http.ts     # Streamable HTTP host (stateless; SelectKey per request header)
  stdio.ts    # stdio host (SelectKey from SELECTWIN_API_KEY)
  docs.ts     # docs tools (fetch the public docs endpoints)
  api.ts      # host-locked API client + write/financial gating
  spec.ts     # vendored openapi.json access (operations, reference summary)
  config.ts   # ServerConfig + env parsing
openapi.json  # vendored spec (refresh: npm run sync:spec)
```

The server is self-contained: docs tools call the public docs site; API tools drive the vendored
OpenAPI spec and talk to `api.selectwin.io`. Nothing depends on the docs app internals.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (spec, docs, api, full protocol via in-memory transport)
npm run build       # tsup → dist/ (server, http, stdio)
npm run sync:spec   # refresh openapi.json from selectwin-docs
```

## Roadmap

- OAuth 2.1 for a hosted multi-tenant deployment (replacing SelectKey-by-header).
- Write confirmation UX via MCP elicitation for financial operations.
- Publish to npm.
