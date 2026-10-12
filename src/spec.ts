/** Access to the vendored OpenAPI spec (openapi.json), driving the API tools. */
import openapi from '../openapi.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const spec: any = openapi;

export interface Operation {
  operationId: string;
  method: string; // upper-case HTTP verb
  path: string; // e.g. /v1/customers/{customerId}
  summary: string;
  tags: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Financial resources: mutating these moves money and needs the extra flag. */
const FINANCIAL = /\/(transactions|withdrawals|charges|refunds?|disputes?|payouts?)\b|\/(refund|capture|dispute)\b/i;

/**
 * The ONLY writes allowed with `MCP_ENABLE_WRITES` alone: low-risk catalog/CRM edits that neither move money, nor send
 * data to a new place, nor delete anything. Every other write — and any operation added to the spec later — is
 * SENSITIVE and also needs `MCP_ENABLE_FINANCIAL_WRITES` (default-deny; company security sweep 12/10/2026, SDK-1).
 *
 * Why an allowlist and not the path regex alone: the regex let 41 writes through as "non-financial", among them
 * revenue splits to another company (`addSubscriptionSplit`), paying a checkout with a stored card
 * (`submitCheckoutPayment`), billing a subscription cycle, coupons, webhooks that ship every event (with PII) to any URL,
 * secret rotation, price changes and every DELETE — all reachable by a prompt injection in a customer or product name.
 */
const STANDARD_WRITES: ReadonlySet<string> = new Set([
  'createCustomer',
  'updateCustomer',
  'updateCustomer__put',
  'createAddress',
  'updateAddress',
  'updateAddress__patch',
  'createProduct',
  'createProductVariant',
  'createCheckoutSession',
  'updateCheckoutSession',
  'createCheckoutPaymentLink',
  'validateCoupon',
  'testWebhookEndpoint',
]);

let cache: Operation[] | null = null;

export function listOperations(): Operation[] {
  if (cache) return cache;
  const out: Operation[] = [];
  const paths = spec.paths ?? {};
  for (const path of Object.keys(paths)) {
    const item = paths[path];
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      out.push({
        operationId: op.operationId ?? `${method}_${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description ?? '',
        tags: Array.isArray(op.tags) ? op.tags : [],
      });
    }
  }
  cache = out.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return cache;
}

export function findOperation(operationId: string): Operation | undefined {
  return listOperations().find((o) => o.operationId === operationId);
}

export function isMutation(method: string): boolean {
  return method.toUpperCase() !== 'GET';
}

export function isFinancialPath(path: string): boolean {
  return FINANCIAL.test(path);
}

/**
 * A write that needs the second flag: money-moving (the financial paths), or simply not on the standard allowlist —
 * splits, subscriptions, checkout pay, coupons, cards, wallets, webhooks, price edits, deletes, and anything new.
 */
export function isSensitiveWrite(op: Pick<Operation, 'method' | 'path' | 'operationId'>): boolean {
  if (!isMutation(op.method)) return false;
  return isFinancialPath(op.path) || !STANDARD_WRITES.has(op.operationId);
}

/** A compact reference: operations grouped by tag, for `list_api_reference`. */
export function apiReferenceSummary(): string {
  const ops = listOperations();
  const byTag = new Map<string, Operation[]>();
  for (const op of ops) {
    const tag = op.tags[0] ?? 'other';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(op);
  }
  const lines: string[] = [`Selectwin API v${spec.info?.version ?? '?'} — ${ops.length} operations`, ''];
  for (const tag of [...byTag.keys()].sort()) {
    lines.push(`## ${tag}`);
    for (const op of byTag.get(tag)!) {
      lines.push(`- ${op.operationId} — ${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
