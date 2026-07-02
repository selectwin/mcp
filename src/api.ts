/** API tool — a host-locked fetch client to api.selectwin.io, driven by the spec. */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { findOperation, isFinancialPath, isMutation, type Operation } from './spec.js';

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
  if (isMutation(op.method) && !config.enableWrites) {
    throw new ApiToolError(
      `Operation '${op.operationId}' is a write (${op.method}) and writes are disabled. Set MCP_ENABLE_WRITES=true to allow.`,
    );
  }
  if (isMutation(op.method) && isFinancialPath(op.path) && !config.enableFinancialWrites) {
    throw new ApiToolError(
      `Operation '${op.operationId}' is a FINANCIAL write and is disabled. Set MCP_ENABLE_FINANCIAL_WRITES=true (and confirm with the user) to allow.`,
    );
  }
  if (!config.selectKey) {
    throw new ApiToolError('Missing SelectKey. Set the `selectkey` header (HTTP) or SELECTWIN_API_KEY (stdio).');
  }

  const url = buildUrl(config, op, input);
  const headers: Record<string, string> = {
    selectkey: config.selectKey,
    'User-Agent': config.userAgent,
    Accept: 'application/json',
  };
  const init: RequestInit = { method: op.method, headers };
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
