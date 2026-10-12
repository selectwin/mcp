import { describe, it, expect } from 'vitest';
import { configFromEnv } from '../src/config';
import { ApiToolError, callApi } from '../src/api';

function capturing(status = 200, body: unknown = { data: [] }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const base = (over = {}) =>
  configFromEnv({ selectKey: 'sk_test_x', apiUrl: 'https://api.selectwin.io', fetchImpl: capturing().fetchImpl, ...over });

describe('callApi', () => {
  it('sends the SelectKey header on a GET and hits the right URL', async () => {
    const { calls, fetchImpl } = capturing(200, { balance: 1000 });
    const res = await callApi(base({ fetchImpl }), { operationId: 'getBalance' });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.selectwin.io/v1/balance');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as any).selectkey).toBe('sk_test_x');
    expect((calls[0].init.headers as any)['X-Idempotency-Key']).toBeUndefined();
  });

  it('fills path params and query', async () => {
    const { calls, fetchImpl } = capturing();
    await callApi(base({ fetchImpl }), {
      operationId: 'getCustomer',
      pathParams: { customerId: 'cus_1' },
      query: { expand: 'cards' },
    });
    expect(calls[0].url).toBe('https://api.selectwin.io/v1/customers/cus_1?expand=cards');
  });

  it('throws on a missing required path param', async () => {
    await expect(callApi(base(), { operationId: 'getCustomer' })).rejects.toBeInstanceOf(ApiToolError);
  });

  it('blocks writes unless enabled, then adds an idempotency key + JSON body', async () => {
    await expect(
      callApi(base(), { operationId: 'createCustomer', body: { firstName: 'A' } }),
    ).rejects.toThrow(/writes are disabled/i);

    const { calls, fetchImpl } = capturing(201, { id: 'cus_1' });
    await callApi(base({ enableWrites: true, fetchImpl }), {
      operationId: 'createCustomer',
      body: { firstName: 'Ana', email: 'a@b.co' },
    });
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as any)['X-Idempotency-Key']).toHaveLength(36);
    expect(JSON.parse(calls[0].init.body as string).email).toBe('a@b.co');
  });

  it('blocks financial writes unless the financial flag is set', async () => {
    await expect(
      callApi(base({ enableWrites: true }), { operationId: 'createTransaction', body: { amount: 100 } }),
    ).rejects.toThrow(/financial/i);

    const { calls, fetchImpl } = capturing(201, { id: 'tra_1' });
    const res = await callApi(
      base({ enableWrites: true, enableFinancialWrites: true, fetchImpl }),
      { operationId: 'createTransaction', body: { amount: 100 } },
    );
    expect(res.status).toBe(201);
    expect(calls[0].url).toBe('https://api.selectwin.io/v1/transactions');
  });

  it('default-deny: splits, checkout pay, coupons, webhooks, cards and deletes need the financial flag (SDK-1)', async () => {
    for (const operationId of [
      'addSubscriptionSplit',
      'submitCheckoutPayment',
      'renewSubscriptionCycle',
      'createCoupon',
      'createWebhookEndpoint',
      'rotateWebhookSecret',
      'createCard',
      'deleteCustomer',
      'updateProductVariant',
    ]) {
      await expect(callApi(base({ enableWrites: true }), { operationId, body: {}, pathParams: { subscriptionId: 's', sessionId: 's', id: 'w', customerId: 'c', productId: 'p', variantId: 'v' } }))
        .rejects.toThrow(/FINANCIAL\/SENSITIVE/);
    }
    // A standard write still works with MCP_ENABLE_WRITES alone.
    const { calls, fetchImpl } = capturing(201, { id: 'adr_1' });
    await callApi(base({ enableWrites: true, fetchImpl }), { operationId: 'createAddress', body: { postcode: '01001000' } });
    expect(calls).toHaveLength(1);
  });

  it('requires a SelectKey and a known operationId', async () => {
    await expect(
      callApi(base({ selectKey: undefined }), { operationId: 'getBalance' }),
    ).rejects.toThrow(/SelectKey/i);
    await expect(callApi(base(), { operationId: 'nope' })).rejects.toThrow(/Unknown operationId/i);
  });
});
