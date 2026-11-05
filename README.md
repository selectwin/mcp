# @selectwin/mcp

Official **Selectwin** MCP server — lets AI assistants (Claude Code, Cursor, VS Code, Claude Desktop, …) **read the
Selectwin docs** and **query your Selectwin account** over the Model Context Protocol.

Two ways to use it:

| | Hosted — `https://mcp.selectwin.io/mcp` | Local — `npx -y @selectwin/mcp` |
|---|---|---|
| Install | nothing | Node 18+ |
| Account access | **read-only**: 56 curated reads (balance, sales, receivables, withdrawals, checkout, catalog, subscriptions, coupons, simulators, customers, webhooks, marketplace) | every read; writes behind flags (see Safety) |
| Auth | your SelectKey in the `selectkey` header | `SELECTWIN_API_KEY` |

The environment (sandbox/production) follows the key prefix (`sk_test_` / `sk_live_`). Use a `sk_test_` key to try it.

## Connect to the hosted server

**Claude Code**

```bash
claude mcp add --transport http selectwin https://mcp.selectwin.io/mcp --header "selectkey: sk_test_…"
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "selectwin": { "url": "https://mcp.selectwin.io/mcp", "headers": { "selectkey": "sk_test_…" } }
  }
}
```

**VS Code** (`.vscode/mcp.json` — asks for the key once, stored by VS Code)

```json
{
  "inputs": [{ "type": "promptString", "id": "selectkey", "description": "Selectwin SelectKey", "password": true }],
  "servers": {
    "selectwin": { "type": "http", "url": "https://mcp.selectwin.io/mcp", "headers": { "selectkey": "${input:selectkey}" } }
  }
}
```

Clients that can only send a bearer token may use `Authorization: Bearer sk_…` instead of the `selectkey` header.
Connectors that require OAuth (claude.ai, ChatGPT) are not supported yet — see Roadmap.

## Run locally (stdio)

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

## What it exposes

**Tools**
- `search_docs(query, limit?)` — full-text search over the docs + API reference.
- `get_llms_txt(sector?)` — the docs as text: the index (`llms.txt`), or one sector (`/llms/<sector>.txt`).
- `list_api_reference()` — every API operation (operationId, method, path) grouped by resource; on the hosted server
  the ones it can run are marked `[callable]`.
- `get_operation(operationId)` — one operation's contract (parameters, body, responses with the schemas inlined).
- `call_api({ operationId, pathParams?, query?, body?, idempotencyKey? })` — execute an API operation.

**Resources** — `selectwin://openapi.json` (the whole document), `selectwin://llms.txt` (the whole docs corpus).

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `SELECTWIN_API_KEY` | — | SelectKey for stdio (HTTP takes it from each request) |
| `SELECTWIN_API_URL` | `https://api.selectwin.io` | API base (host-locked target) |
| `SELECTWIN_DOCS_URL` | `https://selectwin.io` | docs site used by the docs tools |
| `MCP_ENABLE_WRITES` | `false` | allow the standard (low-risk) writes |
| `MCP_ENABLE_FINANCIAL_WRITES` | `false` | allow financial/sensitive writes — everything outside the standard allowlist |
| `MCP_HOSTED` | `false` | the public deployment: read-only, `call_api` runs only `HOSTED_READS`, the write flags are ignored |
| `MCP_ALLOWED_HOSTS` | — | HTTP: accepted `Host` values (comma list); empty accepts any |
| `MCP_ALLOWED_ORIGINS` | — | HTTP: browser origins accepted; a request with any other `Origin` is refused |
| `MCP_CLIENT_IP_HEADER` | — | HTTP: header the edge writes with the client IP (else the socket peer) |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | HTTP: requests per minute per client IP |
| `PORT` / `MCP_PATH` | `3000` / `/mcp` | HTTP host |

## Safety

- **The hosted server is read-only.** `MCP_HOSTED=true` refuses every write and every read outside `HOSTED_READS`
  (`src/spec.ts`) — stored cards, payout wallets, KYC-by-token routes, the raw session trace and any operation the API
  gains later stay out. No environment variable turns writes on there.
- **Locally, read-only by default.** `MCP_ENABLE_WRITES` alone allows ONLY a short allowlist of low-risk edits:
  create/update customers and addresses, create products and variants, build checkout sessions and payment links,
  validate a coupon, test a webhook. Everything else — money (transactions, withdrawals, refunds, captures, disputes,
  checkout pay), subscriptions and revenue splits, coupons, cards, wallets, webhook endpoints and secrets,
  product/variant edits (prices), every DELETE, and any operation added later — also needs
  `MCP_ENABLE_FINANCIAL_WRITES`. Never enable it for an autonomous agent.
- **API responses are marked as untrusted data.** Names, descriptions and metadata come from buyers and merchants; the
  `call_api` output tells the model not to follow instructions inside it.
- **Host-locked.** API calls only ever go to the configured Selectwin API origin.
- **The SelectKey is never logged.** The access log records the key's environment (`live`/`test`), never the key.
- **HTTP guards:** `Host` and `Origin` checks, a per-IP rate limit, a 1 MB body cap, 30 s timeout on API calls.

## Architecture

```
src/
  server.ts   # createServer(config) — registers all tools + resources
  http.ts     # Streamable HTTP host (stateless; SelectKey per request)
  guard.ts    # HTTP guards: Host/Origin, rate limit, body cap, where the SelectKey comes from
  stdio.ts    # stdio host (SelectKey from SELECTWIN_API_KEY)
  docs.ts     # docs tools (fetch the public docs endpoints)
  api.ts      # host-locked API client + hosted/write/financial gating
  spec.ts     # vendored openapi.json access (operations, HOSTED_READS, reference summary, operation detail)
  config.ts   # ServerConfig + env parsing
openapi.json  # vendored spec — synced weekly from selectwin.io (spec-sync workflow)
```

## Deploy (mcp.selectwin.io)

No hand step: a push to `main` that touches the server runs `image.yml`, which tests, pushes
`ghcr.io/selectwin/mcp:sha-<7>` and pins `docker/stack/app.yml` to it in a `deploy(image): …` commit; the Dokploy
stack deploys that commit. `spec-sync.yml` refreshes `openapi.json` every Monday and redeploys when it changed.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (spec, docs, api, guards, full protocol via in-memory transport)
npm run build       # tsup → dist/ (server, http, stdio)
npm run sync:spec   # refresh openapi.json from selectwin.io
docker build -t selectwin-mcp . && docker run -p 3000:3000 -e MCP_HOSTED=true selectwin-mcp
```

## Roadmap

- OAuth 2.1 ("Connect with Selectwin") so OAuth-only connectors (claude.ai, ChatGPT) can use the hosted server.
- Write confirmation UX via MCP elicitation for financial operations.
