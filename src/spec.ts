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

/**
 * The ONLY operations the HOSTED server (`MCP_HOSTED=true`, mcp.selectwin.io) executes: reads a seller asks an
 * assistant about, chosen by the owner on 05/11/2026. Everything else — every write, and any read not listed here
 * (stored cards, payout wallets with the account number and Pix key in clear, the KYC-by-token routes of the onboarding
 * screen, the raw session trace, tokenization plumbing, standalone addresses, the BIN/CEP/CNPJ utilities) and any
 * operation added to the spec later — is refused there (default-deny). The local server (stdio) is not bound by it.
 */
export const HOSTED_READS: ReadonlySet<string> = new Set([
  // Balance and statement
  'getBalance', 'listBalanceHistory', 'listDebtSettlements',
  // Sales
  'listTransactions', 'getTransaction',
  // Receivables
  'listReceivables', 'getReceivable', 'receivablesSchedule',
  // Withdrawals (the destination comes masked)
  'listWithdrawals', 'getWithdrawal', 'getWithdrawalDestinations',
  // Checkout and payment links (with the abandonment diagnosis)
  'listCheckoutPaymentLinks', 'getCheckoutPaymentLink', 'listCheckoutSessions', 'getCheckoutSession',
  'getCheckoutSessionBehavior',
  // Catalog
  'listProducts', 'getProduct', 'listProductVariants', 'getProductVariant', 'listAllVariants', 'getVariant',
  // Subscriptions
  'listSubscriptions', 'getSubscription', 'listSubscriptionCycles', 'getSubscriptionCycle', 'listSubscriptionItems',
  'getSubscriptionItem',
  // Subscriptions — metered usage, thresholds and revenue splits
  'getSubscriptionCycleUsage', 'listSubscriptionUsage', 'listSubscriptionThresholds', 'listSubscriptionSplits',
  'getSubscriptionSplit',
  // Coupons
  'listCoupons', 'getCoupon',
  // Fee and installment simulators
  'simulateInstallment', 'simulateInstallments', 'simulatePaymentMethods',
  // Customers
  'listCustomers', 'getCustomer',
  // Webhooks (integration debugging)
  'listWebhookEndpoints', 'getWebhookEndpoint', 'listWebhookDispatches', 'listWebhookEvents', 'getWebhookEvent',
  'utilsTypesOfWebhooks',
  // Marketplace (sellers with sub-accounts)
  'getMarketplaceStatus', 'listMarketplacePlans', 'getMarketplacePlan', 'listSubAccounts', 'getSubAccount',
  'getSubAccountOnboarding', 'getSubAccountClosureRequest', 'getSubAccountKycLink',
  // Public prices and API capabilities
  'getPublicPricing', 'utilsMetadata',
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

/**
 * A compact reference: operations grouped by tag, for `list_api_reference`. On the hosted server the operations it can
 * execute are marked `[callable]`; the rest stay listed because the reference also serves whoever is writing code.
 */
export function apiReferenceSummary(options: { hosted?: boolean } = {}): string {
  const ops = listOperations();
  const byTag = new Map<string, Operation[]>();
  for (const op of ops) {
    const tag = op.tags[0] ?? 'other';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(op);
  }
  const lines: string[] = [`Selectwin API v${spec.info?.version ?? '?'} — ${ops.length} operations`, ''];
  if (options.hosted) {
    lines.push(
      `This hosted server is read-only: call_api runs only the ${HOSTED_READS.size} operations marked [callable].`,
      'The others are listed for reference (writing an integration); they run from the local server (npx -y @selectwin/mcp).',
      '',
    );
  }
  for (const tag of [...byTag.keys()].sort()) {
    lines.push(`## ${tag}`);
    for (const op of byTag.get(tag)!) {
      const mark = options.hosted && HOSTED_READS.has(op.operationId) ? ' [callable]' : '';
      lines.push(`- ${op.operationId}${mark} — ${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** How deep `$ref`s are inlined in `operationDetail` — enough for request/response shapes, bounded for the context. */
const MAX_REF_DEPTH = 4;

function lookupRef(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: any = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return undefined;
  }
  return node;
}

function inlineRefs(node: unknown, depth: number, seen: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, depth, seen));
  if (!node || typeof node !== 'object') return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    // A cycle or the depth limit keeps the pointer — the model can ask for less, never gets an endless document.
    if (seen.has(ref) || depth >= MAX_REF_DEPTH) return { $ref: ref };
    const target = lookupRef(ref);
    if (target === undefined) return { $ref: ref };
    return inlineRefs(target, depth + 1, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = inlineRefs(v, depth, seen);
  return out;
}

/**
 * One operation's contract — parameters, request body and responses with the schemas inlined — for `get_operation`.
 * The whole document (~1.8 MB) does not fit a model's context; one operation does.
 */
export function operationDetail(operationId: string): Record<string, unknown> | undefined {
  const op = findOperation(operationId);
  if (!op) return undefined;
  const item = spec.paths[op.path] ?? {};
  const raw = item[op.method.toLowerCase()] ?? {};
  const parameters = [...(item.parameters ?? []), ...(raw.parameters ?? [])];
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    tags: op.tags,
    summary: raw.summary,
    description: raw.description,
    ...(parameters.length ? { parameters: inlineRefs(parameters, 0, new Set()) } : {}),
    ...(raw.requestBody ? { requestBody: inlineRefs(raw.requestBody, 0, new Set()) } : {}),
    responses: inlineRefs(raw.responses ?? {}, 0, new Set()),
  };
}
