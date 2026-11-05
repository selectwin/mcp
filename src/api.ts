/** API tool — a host-locked fetch client to api.selectwin.io, driven by the spec. */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { HOSTED_READS, findOperation, isMutation, isSensitiveWrite, type Operation } from './spec.js';

/** A Selectwin API call that takes longer than this is abandoned (the tool answers with the error). */
const API_TIMEOUT_MS = 30_000;

export interface CallApiInput {
  operationId: string;
  pathParams?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface CallApiResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export class ApiToolError extends Error {}

function buildUrl(config: ServerConfig, op: Operation, input: CallApiInput): string {
  let path = op.path;
  const params = input.pathParams ?? {};
  path = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new ApiToolError(`Missing path parameter '${name}' for ${op.operationId}.`);
    }
    // A dot segment survives encodeURIComponent and the URL parser resolves it: `productId: '..'` would turn
    // /v1/products/{productId}/variants into /v1/variants — another operation than the one the gates judged.
    if (value === '.' || value === '..') {
      throw new ApiToolError(`Invalid path parameter '${name}' for ${op.operationId}.`);
    }
    return encodeURIComponent(String(value));
  });
  const url = new URL(config.apiUrl + path);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  // Host lock: never talk to anything but the configured API origin.
  if (url.origin !== new URL(config.apiUrl).origin) {
    throw new ApiToolError('Refusing to call a non-Selectwin host.');
  }
  return url.toString();
}

/**
 * Resolve + execute an API operation. Enforces the write / financial-write gates
 * and requires a SelectKey. Never logs the key.
 */
export async function callApi(config: ServerConfig, input: CallApiInput): Promise<CallApiResult> {
  const op = findOperation(input.operationId);
  if (!op) {
    throw new ApiToolError(`Unknown operationId '${input.operationId}'. Use list_api_reference to discover valid ids.`);
  }
  if (config.hosted && !HOSTED_READS.has(op.operationId)) {
    throw new ApiToolError(
      `Operation '${op.operationId}' is not available on the hosted Selectwin MCP, which is read-only and runs only the ` +
        'operations marked [callable] in list_api_reference. The full API runs from the local server (npx -y @selectwin/mcp).',
    );
  }
  if (isMutation(op.method) && !config.enableWrites) {
    throw new ApiToolError(
      `Operation '${op.operationId}' is a write (${op.method}) and writes are disabled. Set MCP_ENABLE_WRITES=true to allow.`,
    );
  }
  if (isSensitiveWrite(op) && !config.enableFinancialWrites) {
    throw new ApiToolError(
      `Operation '${op.operationId}' is a FINANCIAL/SENSITIVE write (moves money, sends data elsewhere or deletes) and is disabled. ` +
        'Set MCP_ENABLE_FINANCIAL_WRITES=true (and confirm with the user) to allow.',
    );
  }
  if (!config.selectKey && !config.apiToken) {
    throw new ApiToolError(
      'Missing credentials. Sign in (OAuth), send the `selectkey` header (or `Authorization: Bearer sk_…`) over HTTP, or set SELECTWIN_API_KEY (stdio).',
    );
  }

  const url = buildUrl(config, op, input);
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/json',
  };
  // An OAuth caller's API token (from the exchange) wins; otherwise the SelectKey.
  if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
  else headers.selectkey = config.selectKey!;
  const init: RequestInit = { method: op.method, headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) };
  if (isMutation(op.method)) {
    headers['X-Idempotency-Key'] = input.idempotencyKey ?? randomUUID();
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(input.body);
    }
  }

  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { status: res.status, ok: res.ok, body };
}
