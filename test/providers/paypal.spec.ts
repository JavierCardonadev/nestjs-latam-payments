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
