import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentsConfigurationError, WebhookVerificationError } from '../../src/core/errors.js';
import { MercadoPagoProvider, type MercadoPagoConfig } from '../../src/providers/mercadopago/mercadopago.provider.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const SECRET = 'mp-webhook-secret';
const hmac = (s: string) => createHmac('sha256', SECRET).update(s).digest('hex');

function provider(routes: MockRoute[] = [], config: Partial<MercadoPagoConfig> = {}) {
  const mock = mockFetch(routes);
  const mp = new MercadoPagoProvider({
    accessToken: 'TEST-123',
    webhookSecret: SECRET,
    ...config,
    http: { fetch: mock.fetch },
  });
  return { mp, calls: mock.calls };
}

const payment = {
  id: 123456789,
  status: 'approved',
  transaction_amount: 1500.5,
  transaction_amount_refunded: 0,
  currency_id: 'COP',
  external_reference: 'ORDER-9',
  payment_method_id: 'pse',
  date_created: '2026-09-13T10:00:00.000-05:00',
};

function webhook({
  dataId = '123456789',
  ts = String(Math.floor(Date.now() / 1000)),
  requestId = 'req-1',
  signWith,
}: Record<string, string | undefined> = {}) {
  const manifest = `id:${signWith ?? dataId};request-id:${requestId};ts:${ts};`;
  return {
    headers: { 'x-signature': `ts=${ts},v1=${hmac(manifest)}`, 'x-request-id': requestId },
    query: { 'data.id': dataId, type: 'payment' },
    rawBody: JSON.stringify({ id: 99, type: 'payment', action: 'payment.updated', data: { id: dataId } }),
  };
}

describe('MercadoPagoProvider', () => {
  it('refuses unauthenticated webhooks without hydration', () => {
    expect(() => new MercadoPagoProvider({ accessToken: 'x', hydrateWebhooks: false })).toThrow(
      PaymentsConfigurationError,
    );
  });

  it('creates a Checkout Pro preference in major units', async () => {
    const { mp, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.mercadopago.com/checkout/preferences',
        body: { id: 'pref-1', init_point: 'https://mp.test/init', sandbox_init_point: 'https://mp.test/sandbox' },
      },
    ]);
    const session = await mp.createCheckout({
      amount: 150050,
      currency: 'COP',
      reference: 'ORDER-9',
      description: 'Plan anual',
      successUrl: 'https://shop.test/ok',
      cancelUrl: 'https://shop.test/ko',
      notificationUrl: 'https://shop.test/wh',
      idempotencyKey: 'idem-1',
    });
    expect(session).toMatchObject({ id: 'pref-1', url: 'https://mp.test/init', reference: 'ORDER-9' });
    expect(calls[0]!.headers['X-Idempotency-Key']).toBe('idem-1');
    expect(calls[0]!.json()).toMatchObject({
      items: [{ unit_price: 1500.5, currency_id: 'COP', quantity: 1, title: 'Plan anual' }],
      external_reference: 'ORDER-9',
      back_urls: { success: 'https://shop.test/ok', failure: 'https://shop.test/ko' },
      auto_return: 'approved',
      notification_url: 'https://shop.test/wh',
    });
  });

  it('maps payments, including partial refunds', async () => {
    const { mp } = provider([
      { url: 'https://api.mercadopago.com/v1/payments/1', body: payment },
      {
        url: 'https://api.mercadopago.com/v1/payments/2',
        body: { ...payment, id: 2, transaction_amount_refunded: 500 },
      },
    ]);
    expect(await mp.getPayment('1')).toMatchObject({
      status: 'succeeded',
      amount: 150050,
      method: 'pse',
      reference: 'ORDER-9',
    });
    expect(await mp.getPayment('2')).toMatchObject({ status: 'partially_refunded', amountRefunded: 50000 });
  });

  it('searches by external_reference', async () => {
    const { mp, calls } = provider([
      { url: 'https://api.mercadopago.com/v1/payments/search', body: { results: [payment] } },
    ]);
    expect(await mp.findByReference('ORDER-9')).toMatchObject({ id: '123456789' });
    expect(calls[0]!.url.searchParams.get('external_reference')).toBe('ORDER-9');
  });

  it('always sends an idempotency key on refunds', async () => {
    const { mp, calls } = provider([
      { method: 'GET', url: 'https://api.mercadopago.com/v1/payments/1', body: payment },
      {
        method: 'POST',
        url: 'https://api.mercadopago.com/v1/payments/1/refunds',
        body: { id: 77, status: 'approved', amount: 100 },
      },
    ]);
    const refund = await mp.refund({ paymentId: '1', amount: 10000 });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.json()).toEqual({ amount: 100 });
    expect(post.headers['X-Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(refund).toMatchObject({ id: '77', status: 'succeeded', amount: 10000 });
  });

  describe('webhooks', () => {
    const routes: MockRoute[] = [{ url: 'https://api.mercadopago.com/v1/payments/123456789', body: payment }];

    it('verifies x-signature and hydrates the payment from the API', async () => {
      const { mp, calls } = provider(routes);
      const event = await mp.parseWebhook(webhook());
      expect(event).toMatchObject({
        type: 'payment.succeeded',
        paymentId: '123456789',
        reference: 'ORDER-9',
        amount: 150050,
        id: '99',
      });
      expect(calls).toHaveLength(1);
    });

    it('omits request-id from the manifest when the header is absent (official SDK behaviour)', async () => {
      const ts = '1704908010';
      const request = {
        headers: { 'x-signature': `ts=${ts},v1=${hmac(`id:123456789;ts:${ts};`)}` },
        query: { 'data.id': '123456789' },
        rawBody: JSON.stringify({ type: 'payment', data: { id: '123456789' } }),
      };
      await expect(provider(routes).mp.parseWebhook(request)).resolves.toMatchObject({ type: 'payment.succeeded' });
    });

    it('accepts ids signed in lowercase, as the docs require for alphanumeric ids', async () => {
      const { mp } = provider([{ url: /\/v1\/payments\/ABC123$/, body: payment }]);
      await expect(mp.parseWebhook(webhook({ dataId: 'ABC123', signWith: 'abc123' }))).resolves.toBeDefined();
    });

    it.each([
      [
        'a wrong secret',
        () => ({ ...webhook(), headers: { ...webhook().headers, 'x-signature': 'ts=1,v1=deadbeef' } }),
      ],
      ['a swapped data.id', () => ({ ...webhook(), query: { 'data.id': '999' } })],
      ['a missing header', () => ({ ...webhook(), headers: {} })],
      ['a malformed header', () => ({ ...webhook(), headers: { 'x-signature': 'nope' } })],
    ])('rejects %s', async (_, build) => {
      await expect(provider(routes).mp.parseWebhook(build())).rejects.toThrow(WebhookVerificationError);
    });

    it('enforces the optional tolerance', async () => {
      const { mp } = provider(routes, { webhookToleranceSeconds: 60 });
      await expect(mp.parseWebhook(webhook({ ts: '1704908010' }))).rejects.toThrow(/tolerance/);
    });

    it('never trusts the body status: it is re-fetched', async () => {
      const { mp } = provider([
        { url: 'https://api.mercadopago.com/v1/payments/123456789', body: { ...payment, status: 'rejected' } },
      ]);
      expect((await mp.parseWebhook(webhook())).type).toBe('payment.failed');
    });
  });
});
