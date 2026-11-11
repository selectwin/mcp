import { describe, it, expect } from 'vitest';
import {
  HOSTED_READS,
  apiReferenceSummary,
  findOperation,
  isFinancialPath,
  isMutation,
  isSensitiveWrite,
  listOperations,
  operationDetail,
} from '../src/spec';

describe('spec', () => {
  it('lists all operations', () => {
    // Not an exact count: the weekly spec-sync must pass when the API gains operations (new ones are default-deny).
    expect(listOperations().length).toBeGreaterThanOrEqual(165);
  });

  it('finds an operation by id', () => {
    const op = findOperation('getBalance');
    expect(op?.method).toBe('GET');
    expect(op?.path).toBe('/v1/balance');
    expect(findOperation('nope')).toBeUndefined();
  });

  it('classifies mutations and financial paths', () => {
    expect(isMutation('GET')).toBe(false);
    expect(isMutation('POST')).toBe(true);
    expect(isFinancialPath('/v1/transactions')).toBe(true);
    expect(isFinancialPath('/v1/withdrawals')).toBe(true);
    expect(isFinancialPath('/v1/customers')).toBe(false);
  });

  it('every write outside the standard allowlist is sensitive, including ones added later (default-deny)', () => {
    const writes = listOperations().filter((o) => isMutation(o.method));
    const standard = writes.filter((o) => !isSensitiveWrite(o)).map((o) => o.operationId).sort();
    expect(standard).toEqual([
      'createAddress', 'createCheckoutPaymentLink', 'createCheckoutSession', 'createCustomer', 'createProduct',
      'createProductVariant', 'testWebhookEndpoint', 'updateAddress', 'updateAddress__patch', 'updateCheckoutSession',
      'updateCustomer', 'updateCustomer__put', 'validateCoupon',
    ]);
    expect(isSensitiveWrite({ method: 'POST', path: '/v1/anything-new', operationId: 'brandNewOp' })).toBe(true);
    expect(isSensitiveWrite({ method: 'GET', path: '/v1/transactions', operationId: 'listTransactions' })).toBe(false);
  });

  it('renders a grouped reference summary', () => {
    const summary = apiReferenceSummary();
    expect(summary).toContain('operations');
    expect(summary).toContain('getBalance');
    expect(summary).toContain('createCustomer');
    expect(summary).not.toContain('[callable]');
  });

  it('the hosted reads are the 56 the owner chose, each one a GET that exists in the spec (a sync that drops one fails here)', () => {
    expect(HOSTED_READS.size).toBe(56);
    for (const id of HOSTED_READS) {
      const op = findOperation(id);
      expect(op, id).toBeDefined();
      expect(op!.method, id).toBe('GET');
    }
    // Left out on purpose: stored cards, payout wallets (account and Pix key in clear), KYC-by-token, the raw trace.
    for (const id of ['listCards', 'getCard', 'listWallets', 'getWallet', 'previewKycLink', 'listCheckoutSessionEvents']) {
      expect(HOSTED_READS.has(id), id).toBe(false);
    }
  });

  // The weekly spec-sync deploys whatever selectwin.io serves, with no review. Names alone would let a changed spec point
  // a hosted read at another path (e.g. getCustomer at the payout wallets the owner left out) and still pass: the exact
  // method + path of each of the 56 is pinned (security sweep 31). A real API change updates this map on purpose.
  it('each hosted read still calls the exact method and path it was chosen for', () => {
    const actual = Object.fromEntries([...HOSTED_READS].sort().map((id) => {
      const op = findOperation(id)!;
      return [id, `${op.method} ${op.path}`];
    }));
    expect(actual).toEqual({
      getBalance: "GET /v1/balance",
      getCheckoutPaymentLink: "GET /v1/checkouts/payment-links/{paymentLinkId}",
      getCheckoutSession: "GET /v1/checkouts/sessions/{sessionId}",
      getCheckoutSessionBehavior: "GET /v1/checkouts/sessions/{sessionId}/behavior",
      getCoupon: "GET /v1/coupons/{couponId}",
      getCustomer: "GET /v1/customers/{customerId}",
      getMarketplacePlan: "GET /v1/marketplace/plans/{planId}",
      getMarketplaceStatus: "GET /v1/marketplace",
      getProduct: "GET /v1/products/{productId}",
      getProductVariant: "GET /v1/products/{productId}/variants/{variantId}",
      getPublicPricing: "GET /v1/public/pricing",
      getReceivable: "GET /v1/receivables/{receivableId}",
      getSubAccount: "GET /v1/marketplace/sub-accounts/{companyId}",
      getSubAccountClosureRequest: "GET /v1/marketplace/sub-accounts/{companyId}/closure-request",
      getSubAccountKycLink: "GET /v1/marketplace/sub-accounts/{companyId}/kyc-link",
      getSubAccountOnboarding: "GET /v1/marketplace/sub-accounts/{companyId}/onboarding",
      getSubscription: "GET /v1/subscriptions/{subscriptionId}",
      getSubscriptionCycle: "GET /v1/subscriptions/{subscriptionId}/cycles/{cycleId}",
      getSubscriptionCycleUsage: "GET /v1/subscriptions/{subscriptionId}/cycles/{cycleId}/usage",
      getSubscriptionItem: "GET /v1/subscriptions/{subscriptionId}/items/{itemId}",
      getSubscriptionSplit: "GET /v1/subscriptions/{subscriptionId}/splits/{splitId}",
      getTransaction: "GET /v1/transactions/{transactionId}",
      getVariant: "GET /v1/variants/{variantId}",
      getWebhookEndpoint: "GET /v1/webhooks/{id}",
      getWebhookEvent: "GET /v1/webhooks/events/{eventId}",
      getWithdrawal: "GET /v1/withdrawals/{withdrawalId}",
      getWithdrawalDestinations: "GET /v1/withdrawals/destinations",
      listAllVariants: "GET /v1/variants",
      listBalanceHistory: "GET /v1/balance/history",
      listCheckoutPaymentLinks: "GET /v1/checkouts/payment-links",
      listCheckoutSessions: "GET /v1/checkouts/sessions",
      listCoupons: "GET /v1/coupons",
      listCustomers: "GET /v1/customers",
      listDebtSettlements: "GET /v1/balance/debt-settlements",
      listMarketplacePlans: "GET /v1/marketplace/plans",
      listProductVariants: "GET /v1/products/{productId}/variants",
      listProducts: "GET /v1/products",
      listReceivables: "GET /v1/receivables",
      listSubAccounts: "GET /v1/marketplace/sub-accounts",
      listSubscriptionCycles: "GET /v1/subscriptions/{subscriptionId}/cycles",
      listSubscriptionItems: "GET /v1/subscriptions/{subscriptionId}/items",
      listSubscriptionSplits: "GET /v1/subscriptions/{subscriptionId}/splits",
      listSubscriptionThresholds: "GET /v1/subscriptions/{subscriptionId}/thresholds",
      listSubscriptionUsage: "GET /v1/subscriptions/{subscriptionId}/usage",
      listSubscriptions: "GET /v1/subscriptions",
      listTransactions: "GET /v1/transactions",
      listWebhookDispatches: "GET /v1/webhooks/dispatches",
      listWebhookEndpoints: "GET /v1/webhooks",
      listWebhookEvents: "GET /v1/webhooks/events",
      listWithdrawals: "GET /v1/withdrawals",
      receivablesSchedule: "GET /v1/receivables/schedule",
      simulateInstallment: "GET /v1/simulators/installment",
      simulateInstallments: "GET /v1/simulators/installments",
      simulatePaymentMethods: "GET /v1/simulators/payment-methods",
      utilsMetadata: "GET /v1/utils/metadata",
      utilsTypesOfWebhooks: "GET /v1/utils/types-of-webhooks",
    });
  });

  it('the hosted summary marks exactly the callable operations', () => {
    const summary = apiReferenceSummary({ hosted: true });
    expect(summary.match(/ \[callable\] — /g)).toHaveLength(HOSTED_READS.size);
    expect(summary).toMatch(/- getBalance \[callable\] —/);
    expect(summary).toMatch(/- getCard —/);
  });

  it('operationDetail inlines the schemas of one operation and stays small enough for a tool answer', () => {
    const detail = operationDetail('getBalance')!;
    expect(detail.method).toBe('GET');
    expect(detail.path).toBe('/v1/balance');
    expect(JSON.stringify(detail.responses)).not.toMatch(/"\$ref":"#\/components\/schemas\/Balance/);
    expect(operationDetail('nope')).toBeUndefined();
    const largest = Math.max(...listOperations().map((o) => JSON.stringify(operationDetail(o.operationId)).length));
    expect(largest).toBeLessThan(150_000);
  });
});
