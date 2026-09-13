import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PaymentsConfigurationError,
  PaymentValidationError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../src/core/errors.js';
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

const preapproval = {
  id: '2c938084726fca480172750000000000',
  status: 'authorized',
  reason: 'Plan Pro',
  external_reference: 'TENANT-7',
  payer_email: 'ana@test.co',
  preapproval_plan_id: null,
  date_created: '2026-09-01T10:00:00.000-05:00',
  last_modified: '2026-09-02T10:00:00.000-05:00',
  next_payment_date: '2026-10-01T10:00:00.000-05:00',
  init_point: 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=2c93',
  auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 49900, currency_id: 'COP' },
};

function signedTopic(topic: string, dataId: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${dataId};request-id:req-9;ts:${ts};`;
  return {
    headers: { 'x-signature': `ts=${ts},v1=${hmac(manifest)}`, 'x-request-id': 'req-9' },
    query: { 'data.id': dataId, type: topic },
    rawBody: JSON.stringify({ id: 777, type: topic, action: 'updated', data: { id: dataId } }),
  };
}

describe('MercadoPagoProvider subscriptions', () => {
  it('creates plans, converting weeks and years to days and months', async () => {
    const { mp, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.mercadopago.com/preapproval_plan',
        body: {
          id: 'plan-1',
          status: 'active',
          reason: 'Anual',
          auto_recurring: {
            frequency: 12,
            frequency_type: 'months',
            transaction_amount: 499000,
            currency_id: 'COP',
            repetitions: 3,
            free_trial: { frequency: 15, frequency_type: 'days' },
          },
        },
      },
    ]);
    const plan = await mp.createPlan({
      name: 'Anual',
      amount: 49_900_000,
      currency: 'COP',
      interval: 'year',
      trialDays: 15,
      totalCycles: 3,
      providerOptions: { back_url: 'https://app.test' },
    });
    expect(plan).toMatchObject({
      id: 'plan-1',
      name: 'Anual',
      amount: 49_900_000,
      currency: 'COP',
      interval: 'year',
      intervalCount: 1,
      trialDays: 15,
      totalCycles: 3,
      active: true,
    });
    expect(calls[0].json()).toEqual({
      reason: 'Anual',
      back_url: 'https://app.test',
      auto_recurring: {
        frequency: 12,
        frequency_type: 'months',
        transaction_amount: 499000,
        currency_id: 'COP',
        repetitions: 3,
        free_trial: { frequency: 15, frequency_type: 'days' },
      },
    });

    const weekly = provider([
      {
        method: 'POST',
        url: 'https://api.mercadopago.com/preapproval_plan',
        body: {
          id: 'p2',
          status: 'inactive',
          auto_recurring: {
            frequency: 14,
            frequency_type: 'days',
            free_trial: { frequency: 1, frequency_type: 'months' },
          },
        },
      },
    ]);
    const biweekly = await weekly.mp.createPlan({
      name: 'Q',
      amount: 1000,
      currency: 'ARS',
      interval: 'week',
      intervalCount: 2,
    });
    expect(weekly.calls[0].json().auto_recurring).toMatchObject({ frequency: 14, frequency_type: 'days' });
    expect(biweekly).toMatchObject({
      interval: 'week',
      intervalCount: 2,
      trialDays: 30,
      active: false,
      amount: undefined,
    });
  });

  it('creates a pending subscription from a plan id, keeping the reference', async () => {
    const { mp, calls } = provider([
      {
        method: 'GET',
        url: 'https://api.mercadopago.com/preapproval_plan/plan-1',
        body: {
          id: 'plan-1',
          reason: 'Plan Pro',
          status: 'active',
          auto_recurring: {
            frequency: 1,
            frequency_type: 'months',
            transaction_amount: 49900,
            currency_id: 'COP',
            billing_day: 10,
          },
        },
      },
      {
        method: 'POST',
        url: 'https://api.mercadopago.com/preapproval',
        body: { ...preapproval, status: 'pending', sandbox_init_point: 'https://sandbox.mp/sub' },
      },
    ]);
    const session = await mp.createSubscription({
      reference: 'TENANT-7',
      plan: 'plan-1',
      customer: { email: 'ana@test.co' },
      successUrl: 'https://app.test/billing',
      idempotencyKey: 'sub-7',
    });
    expect(session).toMatchObject({ id: preapproval.id, reference: 'TENANT-7', url: preapproval.init_point });
    expect(calls[1].json()).toEqual({
      reason: 'Plan Pro',
      external_reference: 'TENANT-7',
      payer_email: 'ana@test.co',
      back_url: 'https://app.test/billing',
      status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 49900, currency_id: 'COP' },
    });
    expect(calls[1].headers['X-Idempotency-Key']).toBe('sub-7');
  });

  it('creates a subscription with an inline plan and validates required fields', async () => {
    const { mp, calls } = provider(
      [
        {
          method: 'POST',
          url: 'https://api.mercadopago.com/preapproval',
          body: { ...preapproval, sandbox_init_point: 'https://sandbox.mp/sub' },
        },
      ],
      { useSandboxInitPoint: true },
    );
    const session = await mp.createSubscription({
      reference: 'T-1',
      plan: { name: 'Mensual', amount: 19_900, currency: 'brl', interval: 'month' },
      customer: { email: 'joao@test.br' },
      successUrl: 'https://app.test',
    });
    expect(session.url).toBe('https://sandbox.mp/sub');
    expect(calls[0].json().auto_recurring).toEqual({
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: 199,
      currency_id: 'BRL',
    });

    await expect(mp.createSubscription({ reference: 'T', plan: 'p', successUrl: 'https://app.test' })).rejects.toThrow(
      'customer.email is required',
    );
    await expect(
      mp.createSubscription({ reference: 'T', plan: 'p', customer: { email: 'a@b.co' } }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('reads, finds and changes subscription status', async () => {
    const { mp, calls } = provider([
      { method: 'GET', url: `https://api.mercadopago.com/preapproval/${preapproval.id}`, body: preapproval },
      {
        method: 'GET',
        url: 'https://api.mercadopago.com/preapproval/search',
        body: {
          results: [
            { ...preapproval, id: 'old', date_created: '2026-01-01T00:00:00.000-05:00' },
            { ...preapproval, id: 'new', date_created: '2026-09-01T00:00:00.000-05:00' },
          ],
        },
      },
      {
        method: 'PUT',
        url: `https://api.mercadopago.com/preapproval/${preapproval.id}`,
        body: { ...preapproval, status: 'cancelled' },
      },
    ]);
    expect(await mp.getSubscription(preapproval.id)).toEqual({
      provider: 'mercadopago',
      id: preapproval.id,
      reference: 'TENANT-7',
      status: 'active',
      planId: undefined,
      amount: 4_990_000,
      currency: 'COP',
      interval: 'month',
      intervalCount: 1,
      nextBillingAt: new Date('2026-10-01T15:00:00.000Z'),
      canceledAt: undefined,
      customerEmail: 'ana@test.co',
      createdAt: new Date('2026-09-01T15:00:00.000Z'),
      raw: preapproval,
    });

    expect((await mp.findSubscriptionByReference('TENANT-7'))?.id).toBe('new');
    expect(calls[1].url.searchParams.get('external_reference')).toBe('TENANT-7');

    const canceled = await mp.cancelSubscription({ subscriptionId: preapproval.id });
    expect(canceled).toMatchObject({ status: 'canceled', canceledAt: new Date('2026-09-02T15:00:00.000Z') });
    expect(calls[2].json()).toEqual({ status: 'cancelled' });

    await mp.pauseSubscription(preapproval.id);
    expect(calls[3].json()).toEqual({ status: 'paused' });
    await mp.resumeSubscription(preapproval.id);
    expect(calls[4].json()).toEqual({ status: 'authorized' });

    await expect(mp.cancelSubscription({ subscriptionId: 'x', atPeriodEnd: true })).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );

    const none = provider([{ method: 'GET', url: 'https://api.mercadopago.com/preapproval/search', body: {} }]);
    expect(await none.mp.findSubscriptionByReference('nope')).toBeNull();
  });

  it('hydrates subscription_preapproval webhooks', async () => {
    const { mp } = provider([
      {
        method: 'GET',
        url: `https://api.mercadopago.com/preapproval/${preapproval.id}`,
        body: { ...preapproval, status: 'paused' },
      },
    ]);
    const event = await mp.parseWebhook(signedTopic('subscription_preapproval', preapproval.id));
    expect(event).toMatchObject({
      id: '777',
      type: 'subscription.paused',
      providerType: 'updated',
      subscriptionId: preapproval.id,
      reference: 'TENANT-7',
      amount: 4_990_000,
      subscription: { status: 'paused' },
    });
  });

  it('maps subscription_authorized_payment webhooks to recurring charge events', async () => {
    const invoice = (paymentStatus: string) => ({
      id: 6114264375,
      preapproval_id: preapproval.id,
      external_reference: 'TENANT-7',
      status: 'processed',
      transaction_amount: 49900,
      currency_id: 'COP',
      payment: { id: 1234, status: paymentStatus, status_detail: 'accredited' },
    });
    for (const [status, type] of [
      ['approved', 'subscription.payment_succeeded'],
      ['rejected', 'subscription.payment_failed'],
      ['pending', 'unknown'],
    ]) {
      const { mp, calls } = provider([
        { method: 'GET', url: 'https://api.mercadopago.com/authorized_payments/6114264375', body: invoice(status) },
      ]);
      const event = await mp.parseWebhook(signedTopic('subscription_authorized_payment', '6114264375'));
      expect(event).toMatchObject({
        type,
        paymentId: '1234',
        subscriptionId: preapproval.id,
        reference: 'TENANT-7',
        amount: 4_990_000,
        currency: 'COP',
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('does not hydrate subscription webhooks when hydration is off', async () => {
    const { mp, calls } = provider([], { hydrateWebhooks: false });
    const event = await mp.parseWebhook(signedTopic('subscription_preapproval', 'abc'));
    expect(event).toMatchObject({ type: 'unknown', subscriptionId: 'abc', subscription: undefined });
    const charge = await mp.parseWebhook(signedTopic('subscription_authorized_payment', '1'));
    expect(charge.type).toBe('unknown');
    const other = await mp.parseWebhook(signedTopic('merchant_order', '1'));
    expect(other.type).toBe('unknown');
    expect(calls).toHaveLength(0);
  });
});
