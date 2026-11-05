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
