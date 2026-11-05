# @selectwin/mcp

Official **Selectwin** MCP server — lets AI assistants (claude.ai, Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code, …)
**read the Selectwin docs** and **query your Selectwin account** over the Model Context Protocol.

Two ways to use it:

| | Hosted — `https://mcp.selectwin.io/mcp` | Local — `npx -y @selectwin/mcp` |
|---|---|---|
| Install | nothing | Node 20+ |
| Account access | **read-only**: 56 curated reads (balance, sales, receivables, withdrawals, checkout, catalog, subscriptions, coupons, simulators, customers, webhooks, marketplace) | every read; writes behind flags (see Safety) |
| Auth | **sign in with your Selectwin account** (OAuth) — or your SelectKey in the `selectkey` header | `SELECTWIN_API_KEY` |

Both speak every current MCP revision on the same endpoint: the 2025 ones (`initialize`) and **2026-07-28** (no
sessions, `server/discover`, the per-request envelope).

## Connect to the hosted server — sign in

No key to copy: the assistant opens the Selectwin dashboard, you sign in as always and allow it. The docs tools work
before you sign in; the assistant asks you to connect the first time it needs your account.

- **claude.ai / Claude Desktop:** Settings → Connectors → **Add custom connector** → `https://mcp.selectwin.io/mcp`.
- **Claude Code:** `claude mcp add --transport http selectwin https://mcp.selectwin.io/mcp`, then `/mcp` → **Authenticate**.
- **ChatGPT:** add a connector (developer mode) with the URL `https://mcp.selectwin.io/mcp`.

What you allow is **read-only** (`mcp:read`): the same 56 reads as above, on the company and environment you are signed
into in the dashboard. It creates, changes and deletes nothing and moves no money. The connection shows up in
**Account → Sessions**, and ending that session cuts it off.

## Connect to the hosted server — with a SelectKey

For clients configured by file. The environment (sandbox/production) follows the key prefix (`sk_test_` / `sk_live_`);
use a `sk_test_` key to try it.

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
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` | — | HTTP: this server's client at the Selectwin authorization server, allowed to trade tokens (RFC 8693). Both set ⇒ OAuth on |
| `MCP_RESOURCE_URL` | `https://mcp.selectwin.io/mcp` | HTTP: this server's canonical URI (RFC 8707) — the protected resource metadata `resource` |
| `SELECTWIN_OAUTH_ISSUER` | `{SELECTWIN_API_URL}/v1/authentication/oauth` | HTTP: the authorization server |
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
- **The client's token is never passed on.** A signed-in client's token is for this server only; it is traded at the
  authorization server for the same session's API token (RFC 8693), which never leaves this server.
- **No key or token is ever logged.** The access log records only how the caller authenticated (`live`/`test`/`oauth`).
- **HTTP guards:** `Host` and `Origin` checks, a per-IP rate limit, a 1 MB body cap, 30 s timeout on API calls.

## Architecture

```
src/
  server.ts   # createServer(config) — registers all tools + resources
  app.ts      # the Streamable HTTP host (stateless; credential per request; the 401 that asks a client to sign in)
  http.ts     # reads the env and listens
  oauth.ts    # OAuth resource server: protected resource metadata, the challenge, the RFC 8693 token exchange
  guard.ts    # HTTP guards: Host/Origin, rate limit, body cap, where the SelectKey / bearer token comes from
  stdio.ts    # stdio host (SelectKey from SELECTWIN_API_KEY)
  docs.ts     # docs tools (fetch the public docs endpoints)
  api.ts      # host-locked API client + hosted/write/financial gating
  spec.ts     # vendored openapi.json access (operations, HOSTED_READS, reference summary, operation detail)
  config.ts   # ServerConfig + env parsing
openapi.json  # vendored spec — synced weekly from selectwin.io (spec-sync workflow)
docker/       # the hosted deployment (how it ships: the header of docker/stack/app.yml)
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (spec, docs, api, guards, full protocol via in-memory transport)
npm run build       # tsup → dist/ (server, http, stdio)
npm run sync:spec   # refresh openapi.json from selectwin.io
docker build -t selectwin-mcp . && docker run -p 3000:3000 -e MCP_HOSTED=true selectwin-mcp
```

## Roadmap

- Write confirmation UX via MCP elicitation for financial operations.
