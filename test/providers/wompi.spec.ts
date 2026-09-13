import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PaymentsConfigurationError,
  PaymentValidationError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../src/core/errors.js';
import { WompiProvider, type WompiConfig } from '../../src/providers/wompi/wompi.provider.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const baseConfig: WompiConfig = {
  publicKey: 'pub_test_abc',
  privateKey: 'prv_test_xyz',
  integritySecret: 'test_integrity_secret',
  eventsSecret: 'test_events_secret',
};

function provider(routes: MockRoute[] = [], config: Partial<WompiConfig> = {}) {
  const mock = mockFetch(routes);
  return { wompi: new WompiProvider({ ...baseConfig, ...config, http: { fetch: mock.fetch } }), calls: mock.calls };
}

function signedEvent(transaction: Record<string, unknown>, secret = baseConfig.eventsSecret) {
  const timestamp = 1_530_291_411;
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
  const concatenated = `${transaction.id}${transaction.status}${transaction.amount_in_cents}`;
  return {
    event: 'transaction.updated',
    data: { transaction },
    environment: 'test',
    signature: { properties, checksum: sha256(`${concatenated}${timestamp}${secret}`).toUpperCase() },
    timestamp,
    sent_at: '2018-07-20T16:45:05.000Z',
  };
}

const transaction = {
  id: '1234-1610641025-49201',
  created_at: '2021-01-14T16:17:05.000Z',
  amount_in_cents: 4_490_000,
  reference: 'ORDER-42',
  currency: 'COP',
  payment_method_type: 'NEQUI',
  status: 'APPROVED',
};

describe('WompiProvider', () => {
  it('matches the official integrity-signature example from docs.wompi.co', () => {
    const { wompi } = provider([], {
      publicKey: 'pub_prod_abc',
      integritySecret: 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6',
    });
    expect(wompi.integritySignature('sk8-438k4-xmxm392-sn2m2', 490000, 'COP')).toBe(
      '37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5',
    );
  });

  it('appends expiration-time in the documented position', () => {
    const { wompi } = provider([], { integritySecret: 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6' });
    // Pre-image copied verbatim from the Wompi docs.
    const documented =
      'sk8-438k4-xmxm392-sn2m2490000COP2023-06-09T20:28:50.000Zprod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6';
    expect(wompi.integritySignature('sk8-438k4-xmxm392-sn2m2', 490000, 'COP', '2023-06-09T20:28:50.000Z')).toBe(
      sha256(documented),
    );
  });

  it('infers the environment and rejects mismatched keys', () => {
    expect(provider().wompi.environment).toBe('sandbox');
    expect(provider([], { publicKey: 'pub_prod_1' }).wompi.environment).toBe('production');
    expect(() => new WompiProvider({ ...baseConfig, environment: 'production' })).toThrow(PaymentsConfigurationError);
    expect(() => new WompiProvider({ ...baseConfig, eventsSecret: '' })).toThrow(/eventsSecret/);
  });

  it('builds a signed Web Checkout URL', async () => {
    const { wompi } = provider();
    const session = await wompi.createCheckout({
      amount: 9_500_000,
      currency: 'cop',
      reference: 'ORDER-42',
      successUrl: 'https://shop.test/thanks',
      customer: {
        email: 'ana@test.co',
        name: 'Ana',
        phone: '+57 3001234567',
        documentType: 'CC',
        documentNumber: '123',
      },
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const url = new URL(session.url!);
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('amount-in-cents')).toBe('9500000');
    expect(url.searchParams.get('redirect-url')).toBe('https://shop.test/thanks');
    expect(url.searchParams.get('customer-data:phone-number')).toBe('3001234567');
    expect(url.searchParams.get('customer-data:phone-number-prefix')).toBe('+57');
    expect(url.searchParams.get('signature:integrity')).toBe(
      sha256('ORDER-42' + '9500000' + 'COP' + '2030-01-01T00:00:00.000Z' + 'test_integrity_secret'),
    );
    expect(session.id).toBe('ORDER-42');
    expect(session.form?.method).toBe('GET');
  });

  it('only accepts COP', async () => {
    await expect(provider().wompi.createCheckout({ amount: 100, currency: 'USD', reference: 'r' })).rejects.toThrow(
      PaymentValidationError,
    );
  });

  it('queries transactions with the private key', async () => {
    const { wompi, calls } = provider([
      { url: 'https://sandbox.wompi.co/v1/transactions/1234-1610641025-49201', body: { data: transaction } },
    ]);
    const payment = await wompi.getPayment('1234-1610641025-49201');
    expect(calls[0]!.headers.Authorization).toBe('Bearer prv_test_xyz');
    expect(payment).toMatchObject({
      status: 'succeeded',
      amount: 4_490_000,
      currency: 'COP',
      reference: 'ORDER-42',
      method: 'NEQUI',
    });
  });

  it('voids full card transactions and refuses partial refunds', async () => {
    const { wompi, calls } = provider([
      { method: 'POST', url: /\/transactions\/tx-1\/void$/, body: { data: { status: 'VOIDED', id: 'tx-1' } } },
      { method: 'GET', url: /\/transactions\/tx-1$/, body: { data: { ...transaction, id: 'tx-1' } } },
    ]);
    await expect(wompi.refund({ paymentId: 'tx-1' })).resolves.toMatchObject({ status: 'succeeded' });
    expect(calls[0]!.url.pathname).toBe('/v1/transactions/tx-1/void');
    await expect(wompi.refund({ paymentId: 'tx-1', amount: 100 })).rejects.toThrow(UnsupportedOperationError);
  });

  it('does not pretend to search by reference', async () => {
    await expect(provider().wompi.findByReference()).rejects.toThrow(UnsupportedOperationError);
  });

  describe('webhooks', () => {
    const request = (body: unknown, headers: Record<string, string> = {}) => ({
      headers,
      rawBody: Buffer.from(JSON.stringify(body)),
    });

    it('accepts a valid checksum and normalizes the event', async () => {
      const event = await provider().wompi.parseWebhook(request(signedEvent(transaction)));
      expect(event).toMatchObject({
        provider: 'wompi',
        type: 'payment.succeeded',
        providerType: 'transaction.updated',
        paymentId: '1234-1610641025-49201',
        reference: 'ORDER-42',
        amount: 4_490_000,
        currency: 'COP',
      });
      expect(event.id).toBe('1234-1610641025-49201:APPROVED:1530291411');
    });

    it('prefers the X-Event-Checksum header', async () => {
      const body = signedEvent(transaction);
      const checksum = body.signature.checksum;
      body.signature.checksum = 'garbage';
      await expect(
        provider().wompi.parseWebhook(request(body, { 'X-Event-Checksum': checksum })),
      ).resolves.toBeDefined();
    });

    it.each([
      ['tampered status', (b: any) => (b.data.transaction.status = 'DECLINED')],
      ['tampered amount', (b: any) => (b.data.transaction.amount_in_cents = 1)],
      ['tampered timestamp', (b: any) => (b.timestamp = 1)],
      ['missing signature', (b: any) => delete b.signature],
    ])('rejects %s', async (_, mutate) => {
      const body = signedEvent(transaction);
      mutate(body);
      await expect(provider().wompi.parseWebhook(request(body))).rejects.toThrow(WebhookVerificationError);
    });

    it('rejects events signed with another secret', async () => {
      await expect(provider().wompi.parseWebhook(request(signedEvent(transaction, 'wrong')))).rejects.toThrow(
        /checksum/,
      );
    });

    it('enforces the optional timestamp tolerance', async () => {
      await expect(
        provider([], { webhookToleranceSeconds: 300 }).wompi.parseWebhook(request(signedEvent(transaction))),
      ).rejects.toThrow(/tolerance/);
    });

    it.each([
      ['DECLINED', 'payment.failed'],
      ['VOIDED', 'payment.canceled'],
      ['PENDING', 'payment.pending'],
      ['ERROR', 'payment.failed'],
    ])('maps %s to %s', async (status, type) => {
      const event = await provider().wompi.parseWebhook(request(signedEvent({ ...transaction, status })));
      expect(event.type).toBe(type);
    });
  });
});
