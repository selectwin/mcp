import { describe, it, expect } from 'vitest';
import { listOperations, findOperation, isMutation, isFinancialPath, apiReferenceSummary } from '../src/spec';

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

  it('renders a grouped reference summary', () => {
    const summary = apiReferenceSummary();
    expect(summary).toContain('operations');
    expect(summary).toContain('getBalance');
    expect(summary).toContain('createCustomer');
  });
});
