import { describe, it, expect } from 'vitest';
import { listOperations, findOperation, isMutation, isFinancialPath, isSensitiveWrite, apiReferenceSummary } from '../src/spec';

describe('spec', () => {
  it('lists all operations', () => {
    expect(listOperations().length).toBe(120);
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
  });
});
