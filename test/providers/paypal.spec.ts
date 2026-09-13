import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/core/crypto.js';
import { PaymentValidationError, UnsupportedOperationError, WebhookVerificationError } from '../../src/core/errors.js';
import { PayPalProvider, type PayPalConfig } from '../../src/providers/paypal/paypal.provider.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const WEBHOOK_ID = 'WH-123';
const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42';
const API = 'https://api-m.sandbox.paypal.com';

const TOKEN_ROUTE: MockRoute = {
  method: 'POST',
  url: `${API}/v1/oauth2/token`,
  body: { access_token: 'A21', expires_in: 32400 },
};

function provider(routes: MockRoute[] = [], config: Partial<PayPalConfig> = {}) {
  const mock = mockFetch([TOKEN_ROUTE, ...routes]);
  const downloads: string[] = [];
  const paypal = new PayPalProvider({
    clientId: 'client',
    clientSecret: 'secret',
    webhookId: WEBHOOK_ID,
    http: { fetch: mock.fetch },
    fetchCertificate: async (url) => {
      downloads.push(url);
      return PUBLIC_PEM;
    },
    ...config,
  });
  return { paypal, calls: mock.calls, downloads };
}

function signed(event: unknown, { certUrl = CERT_URL, webhookId = WEBHOOK_ID } = {}) {
  const rawBody = JSON.stringify(event);
  const transmissionId = '69cd13f0-d67a-11e5-baa3-778b53f4ae55';
  const transmissionTime = '2026-09-13T10:00:00Z';
  const signature = createSign('sha256')
    .update(`${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`)
    .sign(privateKey, 'base64');
  return {
    rawBody: Buffer.from(rawBody),
    headers: {
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': signature,
      'paypal-cert-url': certUrl,
      'paypal-auth-algo': 'SHA256withRSA',
    },
  };
}

const completedOrder = {
  id: 'ORDER-5O190127TN364715T',
  status: 'COMPLETED',
  create_time: '2026-09-13T10:00:00Z',
  payment_source: { paypal: {} },
  purchase_units: [
    {
      reference_id: 'ORDER-3',
      custom_id: 'ORDER-3',
      amount: { currency_code: 'BRL', value: '149.90' },
      payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'BRL', value: '149.90' } }] },
    },
  ],
};

describe('PayPalProvider', () => {
  it('creates an order and returns the payer-action link', async () => {
    const { paypal, calls } = provider([
      {
        method: 'POST',
        url: `${API}/v2/checkout/orders`,
        body: {
          id: 'O-1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: 'x' },
            { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=O-1' },
          ],
        },
      },
    ]);
    const session = await paypal.createCheckout({
      amount: 14990,
      currency: 'BRL',
      reference: 'ORDER-3',
      successUrl: 'https://shop.test/ok',
      idempotencyKey: 'idem',
    });
    expect(session).toMatchObject({ id: 'O-1', url: 'https://www.sandbox.paypal.com/checkoutnow?token=O-1' });
    const order = calls.find((c) => c.url.pathname === '/v2/checkout/orders')!;
    expect(order.headers.Authorization).toBe('Bearer A21');
    expect(order.headers['PayPal-Request-Id']).toBe('idem');
    expect(order.json().purchase_units[0]).toMatchObject({
      custom_id: 'ORDER-3',
      amount: { currency_code: 'BRL', value: '149.90' },
    });
  });

  it('caches the OAuth token across concurrent calls', async () => {
    const { paypal, calls } = provider([{ url: /\/v2\/checkout\/orders\/O-1$/, body: completedOrder }]);
    await Promise.all([paypal.getPayment('O-1'), paypal.getPayment('O-1'), paypal.getPayment('O-1')]);
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth2/token')).toHaveLength(1);
    const basic = calls[0]!.headers.Authorization;
    expect(Buffer.from(basic.replace('Basic ', ''), 'base64').toString()).toBe('client:secret');
  });

  it('rejects currencies PayPal does not settle (COP, CLP, ARS...)', async () => {
    await expect(provider().paypal.createCheckout({ amount: 100000, currency: 'COP', reference: 'r' })).rejects.toThrow(
      PaymentValidationError,
    );
  });

  it('sends whole numbers for currencies without decimals', async () => {
    const { paypal, calls } = provider([
      { method: 'POST', url: `${API}/v2/checkout/orders`, body: { id: 'O', links: [] } },
    ]);
    await paypal.createCheckout({ amount: 150000, currency: 'HUF', reference: 'r' });
    expect(calls[1]!.json().purchase_units[0].amount.value).toBe('1500');
    await expect(paypal.createCheckout({ amount: 150050, currency: 'HUF', reference: 'r' })).rejects.toThrow(
      /whole amounts/,
    );
  });

  it('maps orders and refunded totals', async () => {
    const refunded = structuredClone(completedOrder);
    refunded.purchase_units[0]!.payments.captures[0]!.status = 'PARTIALLY_REFUNDED';
    (refunded.purchase_units[0]!.payments as any).refunds = [{ status: 'COMPLETED', amount: { value: '50.00' } }];
    const { paypal } = provider([
      { url: /\/orders\/done$/, body: completedOrder },
      { url: /\/orders\/part$/, body: refunded },
      { url: /\/orders\/approved$/, body: { ...completedOrder, status: 'APPROVED' } },
    ]);
    expect(await paypal.getPayment('done')).toMatchObject({
      status: 'succeeded',
      amount: 14990,
      currency: 'BRL',
      reference: 'ORDER-3',
      method: 'paypal',
    });
    expect(await paypal.getPayment('part')).toMatchObject({ status: 'partially_refunded', amountRefunded: 5000 });
    expect(await paypal.getPayment('approved')).toMatchObject({ status: 'authorized' });
  });

  it('captures idempotently and survives ORDER_ALREADY_CAPTURED', async () => {
    const { paypal, calls } = provider([
      {
        method: 'POST',
        url: /\/capture$/,
        status: 422,
        body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
      },
      { method: 'GET', url: /\/orders\/O-1$/, body: completedOrder },
    ]);
    expect(await paypal.capture('O-1')).toMatchObject({ status: 'succeeded' });
    expect(calls.find((c) => c.url.pathname.endsWith('/capture'))!.headers['PayPal-Request-Id']).toBe('capture-O-1');
  });

  it('refunds the completed capture', async () => {
    const { paypal, calls } = provider([
      { method: 'GET', url: /\/orders\/O-1$/, body: completedOrder },
      {
        method: 'POST',
        url: `${API}/v2/payments/captures/CAP-1/refund`,
        body: { id: 'RF-1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'BRL' } },
      },
    ]);
    expect(await paypal.refund({ paymentId: 'O-1', amount: 1000, reason: 'returned' })).toMatchObject({
      id: 'RF-1',
      status: 'succeeded',
      amount: 1000,
    });
    expect(calls.at(-1)!.json()).toEqual({
      amount: { currency_code: 'BRL', value: '10.00' },
      note_to_payer: 'returned',
    });
  });

  it('has no search by reference', async () => {
    await expect(provider().paypal.findByReference()).rejects.toThrow(UnsupportedOperationError);
  });

  describe('webhooks', () => {
    const captureCompleted = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-09-13T10:00:00Z',
      resource: {
        id: 'CAP-1',
        status: 'COMPLETED',
        custom_id: 'ORDER-3',
        amount: { currency_code: 'BRL', value: '149.90' },
        supplementary_data: { related_ids: { order_id: 'ORDER-5O190127TN364715T' } },
      },
    };

    it('verifies the RSA signature and normalizes the capture', async () => {
      const { paypal, downloads } = provider();
      const event = await paypal.parseWebhook(signed(captureCompleted));
      expect(event).toMatchObject({
        id: 'WH-EVT-1',
        type: 'payment.succeeded',
        paymentId: 'ORDER-5O190127TN364715T',
        reference: 'ORDER-3',
        amount: 14990,
        currency: 'BRL',
      });
      await paypal.parseWebhook(signed(captureCompleted));
      expect(downloads).toEqual([CERT_URL]);
    });

    it('rejects a tampered body', async () => {
      const request = signed(captureCompleted);
      request.rawBody = Buffer.from(request.rawBody.toString().replace('149.90', '1.00'));
      await expect(provider().paypal.parseWebhook(request)).rejects.toThrow(/signature mismatch/);
    });

    it.each([
      'https://evil.example.com/v1/notifications/certs/CERT-1',
      'http://api.paypal.com/v1/notifications/certs/CERT-1',
      'https://api.paypal.com.evil.com/v1/notifications/certs/CERT-1',
      'https://api.paypal.com/uploads/cert.pem',
    ])('refuses certificates from %s', async (certUrl) => {
      const { paypal, downloads } = provider();
      await expect(paypal.parseWebhook(signed(captureCompleted, { certUrl }))).rejects.toThrow(
        WebhookVerificationError,
      );
      expect(downloads).toHaveLength(0);
    });

    it('rejects events signed for another webhook id', async () => {
      await expect(provider().paypal.parseWebhook(signed(captureCompleted, { webhookId: 'WH-OTHER' }))).rejects.toThrow(
        WebhookVerificationError,
      );
    });

    it('requires webhookId', async () => {
      await expect(
        provider([], { webhookId: undefined }).paypal.parseWebhook(signed(captureCompleted)),
      ).rejects.toThrow(/webhookId/);
    });

    it('maps order approval to payment.authorized', async () => {
      const approved = {
        id: 'WH-2',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { ...completedOrder, status: 'APPROVED' },
      };
      expect(await provider().paypal.parseWebhook(signed(approved))).toMatchObject({
        type: 'payment.authorized',
        paymentId: completedOrder.id,
        reference: 'ORDER-3',
      });
    });
  });
});

const subscription = {
  id: 'I-BW452GLLEP1G',
  status: 'ACTIVE',
  plan_id: 'P-5ML4271244454362WXNWU5NQ',
  custom_id: 'TENANT-7',
  create_time: '2026-09-01T10:00:00Z',
  subscriber: { email_address: 'ana@test.com' },
  billing_info: {
    next_billing_time: '2026-10-01T10:00:00Z',
    last_payment: { amount: { currency_code: 'USD', value: '19.99' }, time: '2026-09-01T10:00:00Z' },
    cycle_executions: [{ tenure_type: 'REGULAR', sequence: 1, cycles_completed: 1, cycles_remaining: 0 }],
  },
  links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1' }],
};

describe('PayPalProvider subscriptions', () => {
  it('creates a product and a plan with a trial', async () => {
    const { paypal, calls } = provider([
      { method: 'POST', url: `${API}/v1/catalogs/products`, body: { id: 'PROD-1' } },
      {
        method: 'POST',
        url: `${API}/v1/billing/plans`,
        body: {
          id: 'P-1',
          name: 'Pro',
          status: 'ACTIVE',
          billing_cycles: [
            {
              tenure_type: 'TRIAL',
              sequence: 1,
              total_cycles: 1,
              frequency: { interval_unit: 'DAY', interval_count: 14 },
            },
            {
              tenure_type: 'REGULAR',
              sequence: 2,
              total_cycles: 0,
              frequency: { interval_unit: 'MONTH', interval_count: 1 },
              pricing_scheme: { fixed_price: { value: '19.99', currency_code: 'USD' } },
            },
          ],
        },
      },
    ]);
    const plan = await paypal.createPlan({
      name: 'Pro',
      description: 'Pro plan',
      amount: 1999,
      currency: 'USD',
      interval: 'month',
      trialDays: 14,
      idempotencyKey: 'plan-pro',
    });
    expect(plan).toMatchObject({
      id: 'P-1',
      amount: 1999,
      currency: 'USD',
      interval: 'month',
      intervalCount: 1,
      trialDays: 14,
      totalCycles: undefined,
      active: true,
    });
    expect(calls[1].json()).toEqual({ name: 'Pro', description: 'Pro plan', type: 'SERVICE' });
    expect(calls[1].headers['PayPal-Request-Id']).toBe('plan-pro-product');
    expect(calls[2].json()).toEqual({
      product_id: 'PROD-1',
      name: 'Pro',
      description: 'Pro plan',
      status: 'ACTIVE',
      billing_cycles: [
        { frequency: { interval_unit: 'DAY', interval_count: 14 }, tenure_type: 'TRIAL', sequence: 1, total_cycles: 1 },
        {
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 2,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: '19.99', currency_code: 'USD' } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    });
  });

  it('reuses a product and limits cycles', async () => {
    const { paypal, calls } = provider([
      { method: 'POST', url: `${API}/v1/billing/plans`, body: { id: 'P-2', status: 'CREATED', billing_cycles: [] } },
    ]);
    const plan = await paypal.createPlan({
      name: 'Anual',
      amount: 120000,
      currency: 'MXN',
      interval: 'year',
      totalCycles: 2,
      providerOptions: { productId: 'PROD-9', quantity_supported: true },
    });
    expect(plan).toMatchObject({ id: 'P-2', active: false, amount: undefined, interval: undefined });
    const body = calls[1].json();
    expect(body).toMatchObject({ product_id: 'PROD-9', quantity_supported: true });
    expect(body.productId).toBeUndefined();
    expect(body.billing_cycles).toEqual([
      {
        frequency: { interval_unit: 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 2,
        pricing_scheme: { fixed_price: { value: '1200.00', currency_code: 'MXN' } },
      },
    ]);

    await expect(paypal.createPlan({ name: 'x', amount: 100, currency: 'COP', interval: 'month' })).rejects.toThrow(
      'paypal does not support COP',
    );
    await expect(
      paypal.createPlan({ name: 'x', amount: 100, currency: 'USD', interval: 'month', trialDays: 400 }),
    ).rejects.toThrow('trialDays must be at most 365');
  });

  it('reads plans', async () => {
    const { paypal } = provider([
      {
        method: 'GET',
        url: `${API}/v1/billing/plans/P-3`,
        body: {
          id: 'P-3',
          status: 'ACTIVE',
          billing_cycles: [
            { tenure_type: 'TRIAL', total_cycles: 2, frequency: { interval_unit: 'DAY', interval_count: 7 } },
            {
              tenure_type: 'REGULAR',
              total_cycles: 12,
              frequency: { interval_unit: 'WEEK', interval_count: 2 },
              pricing_scheme: { fixed_price: { value: '5', currency_code: 'JPY' } },
            },
          ],
        },
      },
    ]);
    expect(await paypal.getPlan('P-3')).toMatchObject({
      trialDays: 14,
      interval: 'week',
      intervalCount: 2,
      totalCycles: 12,
      amount: 5,
      currency: 'JPY',
    });
  });

  it('creates subscriptions from a plan id', async () => {
    const { paypal, calls } = provider([
      { method: 'POST', url: `${API}/v1/billing/subscriptions`, body: { ...subscription, status: 'APPROVAL_PENDING' } },
    ]);
    const session = await paypal.createSubscription({
      reference: 'TENANT-7',
      plan: 'P-5ML4271244454362WXNWU5NQ',
      customer: { email: 'ana@test.com', name: 'Ana María López' },
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/ko',
      idempotencyKey: 'sub-7',
    });
    expect(session).toMatchObject({ id: subscription.id, reference: 'TENANT-7', url: subscription.links[0].href });
    expect(calls[1].json()).toEqual({
      plan_id: 'P-5ML4271244454362WXNWU5NQ',
      custom_id: 'TENANT-7',
      subscriber: { email_address: 'ana@test.com', name: { given_name: 'Ana', surname: 'María López' } },
      application_context: {
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: 'https://app.test/ok',
        cancel_url: 'https://app.test/ko',
      },
    });
    expect(calls[1].headers['PayPal-Request-Id']).toBe('sub-7');

    await expect(
      paypal.createSubscription({ reference: 'T', plan: { name: 'x', amount: 1, currency: 'USD', interval: 'month' } }),
    ).rejects.toThrow('create one with createPlan()');
    await expect(paypal.createSubscription({ reference: 'x'.repeat(128), plan: 'P' })).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
  });

  it('maps subscriptions, including trials', async () => {
    const trial = {
      ...subscription,
      billing_info: {
        next_billing_time: '2026-09-15T10:00:00Z',
        cycle_executions: [{ tenure_type: 'TRIAL', cycles_completed: 0, cycles_remaining: 1 }],
      },
    };
    const { paypal } = provider([
      { method: 'GET', url: `${API}/v1/billing/subscriptions/I-BW452GLLEP1G`, body: subscription },
      { method: 'GET', url: `${API}/v1/billing/subscriptions/I-TRIAL`, body: trial },
    ]);
    expect(await paypal.getSubscription('I-BW452GLLEP1G')).toEqual({
      provider: 'paypal',
      id: 'I-BW452GLLEP1G',
      reference: 'TENANT-7',
      status: 'active',
      planId: 'P-5ML4271244454362WXNWU5NQ',
      amount: 1999,
      currency: 'USD',
      currentPeriodEnd: new Date('2026-10-01T10:00:00Z'),
      nextBillingAt: new Date('2026-10-01T10:00:00Z'),
      canceledAt: undefined,
      customerEmail: 'ana@test.com',
      createdAt: new Date('2026-09-01T10:00:00Z'),
      raw: subscription,
    });
    expect(await paypal.getSubscription('I-TRIAL')).toMatchObject({ status: 'trialing', amount: undefined });
    await expect(paypal.findSubscriptionByReference()).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it('cancels, suspends and activates, reading the subscription back', async () => {
    const cancelled = { ...subscription, status: 'CANCELLED', status_update_time: '2026-09-20T10:00:00Z' };
    const { paypal, calls } = provider([
      { method: 'POST', url: /\/v1\/billing\/subscriptions\/I-1\/(cancel|suspend|activate)$/, status: 204 },
      { method: 'GET', url: `${API}/v1/billing/subscriptions/I-1`, body: cancelled },
    ]);
    expect(await paypal.cancelSubscription({ subscriptionId: 'I-1', reason: 'Customer request' })).toMatchObject({
      status: 'canceled',
      canceledAt: new Date('2026-09-20T10:00:00Z'),
      nextBillingAt: undefined,
    });
    expect(calls[1].url.pathname).toBe('/v1/billing/subscriptions/I-1/cancel');
    expect(calls[1].json()).toEqual({ reason: 'Customer request' });

    await paypal.pauseSubscription('I-1');
    expect(calls[3].url.pathname).toBe('/v1/billing/subscriptions/I-1/suspend');
    await paypal.resumeSubscription('I-1');
    expect(calls[5].url.pathname).toBe('/v1/billing/subscriptions/I-1/activate');
    expect(calls[5].json()).toEqual({ reason: 'Resumed by the merchant' });

    await expect(paypal.cancelSubscription({ subscriptionId: 'I-1', atPeriodEnd: true })).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });

  it('maps BILLING.SUBSCRIPTION and PAYMENT.SALE webhooks', async () => {
    const { paypal } = provider();
    const activated = await paypal.parseWebhook(
      signed({
        id: 'WH-1',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        create_time: '2026-09-01T10:00:00Z',
        resource: subscription,
      }),
    );
    expect(activated).toMatchObject({
      type: 'subscription.activated',
      subscriptionId: 'I-BW452GLLEP1G',
      reference: 'TENANT-7',
      amount: 1999,
      currency: 'USD',
      subscription: { status: 'active' },
    });
    expect(activated.status).toBeUndefined();

    for (const [eventType, type] of [
      ['BILLING.SUBSCRIPTION.CREATED', 'subscription.pending'],
      ['BILLING.SUBSCRIPTION.SUSPENDED', 'subscription.paused'],
      ['BILLING.SUBSCRIPTION.CANCELLED', 'subscription.canceled'],
      ['BILLING.SUBSCRIPTION.EXPIRED', 'subscription.expired'],
      ['BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'subscription.payment_failed'],
      ['BILLING.SUBSCRIPTION.SOMETHING', 'unknown'],
    ]) {
      const event = await paypal.parseWebhook(signed({ id: eventType, event_type: eventType, resource: subscription }));
      expect(event.type).toBe(type);
    }

    const sale = await paypal.parseWebhook(
      signed({
        id: 'WH-2',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-1',
          billing_agreement_id: 'I-BW452GLLEP1G',
          custom: 'TENANT-7',
          amount: { total: '19.99', currency: 'USD' },
        },
      }),
    );
    expect(sale).toMatchObject({
      type: 'subscription.payment_succeeded',
      paymentId: 'SALE-1',
      subscriptionId: 'I-BW452GLLEP1G',
      reference: 'TENANT-7',
      amount: 1999,
      currency: 'USD',
    });

    const denied = await paypal.parseWebhook(
      signed({
        id: 'WH-3',
        event_type: 'PAYMENT.SALE.DENIED',
        resource: { id: 'S', billing_agreement_id: 'I-1', amount: {} },
      }),
    );
    expect(denied).toMatchObject({ type: 'subscription.payment_failed', amount: undefined, reference: undefined });

    const plainSale = await paypal.parseWebhook(
      signed({
        id: 'WH-4',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: 'S2', amount: { total: '1.00', currency: 'USD' } },
      }),
    );
    expect(plainSale.type).toBe('unknown');
  });
});
