import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentValidationError, WebhookVerificationError } from '../../src/core/errors.js';
import { StripeProvider, toFormParams, type StripeConfig } from '../../src/providers/stripe/stripe.provider.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const SECRET = 'whsec_test_secret';

function provider(routes: MockRoute[] = [], config: Partial<StripeConfig> = {}) {
  const mock = mockFetch(routes);
  return {
    stripe: new StripeProvider({
      secretKey: 'sk_test_1',
      webhookSecret: SECRET,
      ...config,
      http: { fetch: mock.fetch },
    }),
    calls: mock.calls,
  };
}

function signed(event: unknown, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), extra = '' } = {}) {
  const payload = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return { headers: { 'Stripe-Signature': `t=${timestamp},${extra}v1=${v1}` }, rawBody: Buffer.from(payload) };
}

const intent = {
  id: 'pi_123',
  status: 'succeeded',
  amount: 250000,
  currency: 'mxn',
  created: 1_700_000_000,
  metadata: { reference: 'ORDER-1' },
  latest_charge: { id: 'ch_1', amount_refunded: 0, payment_method_details: { type: 'oxxo' } },
};

describe('StripeProvider', () => {
  it('flattens nested params into bracket notation', () => {
    const form = toFormParams({ a: { b: [{ c: 1 }], d: undefined }, e: 'x' });
    expect(form.toString()).toBe('a%5Bb%5D%5B0%5D%5Bc%5D=1&e=x');
  });

  it('creates a Checkout Session with the reference in client_reference_id and metadata', async () => {
    const { stripe, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', expires_at: 1_900_000_000 },
      },
    ]);
    const session = await stripe.createCheckout({
      amount: 250000,
      currency: 'MXN',
      reference: 'ORDER-1',
      successUrl: 'https://shop.test/ok',
      cancelUrl: 'https://shop.test/ko',
      customer: { email: 'ana@test.mx' },
      idempotencyKey: 'idem-1',
    });
    const form = calls[0]!.form();
    expect(session).toMatchObject({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('idem-1');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('250000');
    expect(form.get('line_items[0][price_data][currency]')).toBe('mxn');
    expect(form.get('client_reference_id')).toBe('ORDER-1');
    expect(form.get('payment_intent_data[metadata][reference]')).toBe('ORDER-1');
  });

  it('requires successUrl for hosted Checkout', async () => {
    await expect(provider().stripe.createCheckout({ amount: 100, currency: 'USD', reference: 'r' })).rejects.toThrow(
      PaymentValidationError,
    );
  });

  it('reads PaymentIntents and detects partial refunds', async () => {
    const { stripe, calls } = provider([
      {
        url: 'https://api.stripe.com/v1/payment_intents/pi_123',
        body: { ...intent, latest_charge: { ...intent.latest_charge, amount_refunded: 1000 } },
      },
    ]);
    expect(await stripe.getPayment('pi_123')).toMatchObject({
      status: 'partially_refunded',
      amount: 250000,
      currency: 'MXN',
      method: 'oxxo',
      reference: 'ORDER-1',
    });
    expect(calls[0]!.url.searchParams.get('expand[0]')).toBe('latest_charge');
  });

  it('resolves Checkout Sessions to their PaymentIntent', async () => {
    const { stripe } = provider([
      {
        url: 'https://api.stripe.com/v1/checkout/sessions/cs_1',
        body: { id: 'cs_1', client_reference_id: 'ORDER-1', payment_intent: intent },
      },
    ]);
    expect(await stripe.getPayment('cs_1')).toMatchObject({ id: 'pi_123', status: 'succeeded', reference: 'ORDER-1' });
  });

  it('maps an unpaid open session to pending', async () => {
    const { stripe } = provider([
      {
        url: 'https://api.stripe.com/v1/checkout/sessions/cs_2',
        body: { id: 'cs_2', status: 'open', payment_status: 'unpaid', payment_intent: null },
      },
    ]);
    expect(await stripe.getPayment('cs_2')).toMatchObject({ id: 'cs_2', status: 'pending' });
  });

  it('searches by metadata reference, escaping quotes', async () => {
    const { stripe, calls } = provider([
      { url: 'https://api.stripe.com/v1/payment_intents/search', body: { data: [intent] } },
    ]);
    await stripe.findByReference("O'Brien-1");
    expect(calls[0]!.url.searchParams.get('query')).toBe("metadata['reference']:'O\\'Brien-1'");
  });

  it('refunds by PaymentIntent', async () => {
    const { stripe, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/refunds',
        body: { id: 're_1', status: 'succeeded', amount: 500, currency: 'mxn' },
      },
    ]);
    expect(await stripe.refund({ paymentId: 'pi_123', amount: 500, reason: 'size' })).toMatchObject({
      id: 're_1',
      status: 'succeeded',
      currency: 'MXN',
    });
    expect(calls[0]!.form().get('metadata[reason]')).toBe('size');
  });

  describe('webhooks', () => {
    const completed = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'cs_1',
          payment_intent: 'pi_123',
          payment_status: 'paid',
          client_reference_id: 'ORDER-1',
          amount_total: 250000,
          currency: 'mxn',
        },
      },
    };

    it('verifies the signature and normalizes checkout.session.completed', async () => {
      expect(await provider().stripe.parseWebhook(signed(completed))).toMatchObject({
        id: 'evt_1',
        type: 'payment.succeeded',
        paymentId: 'pi_123',
        reference: 'ORDER-1',
        amount: 250000,
        currency: 'MXN',
      });
    });

    it('accepts any of several v1 signatures (secret rotation)', async () => {
      const request = signed(completed, {
        extra: 'v1=0000000000000000000000000000000000000000000000000000000000000000,',
      });
      await expect(provider().stripe.parseWebhook(request)).resolves.toBeDefined();
    });

    it('rejects a body modified after signing', async () => {
      const request = signed(completed);
      request.rawBody = Buffer.from(request.rawBody.toString().replace('"paid"', '"unpaid"'));
      await expect(provider().stripe.parseWebhook(request)).rejects.toThrow(WebhookVerificationError);
    });

    it('rejects replays outside the 5-minute tolerance', async () => {
      await expect(provider().stripe.parseWebhook(signed(completed, { timestamp: 1_700_000_000 }))).rejects.toThrow(
        /tolerance/,
      );
    });

    it('rejects other secrets and missing headers', async () => {
      await expect(provider().stripe.parseWebhook(signed(completed, { secret: 'whsec_other' }))).rejects.toThrow(
        /mismatch/,
      );
      await expect(provider().stripe.parseWebhook({ headers: {}, rawBody: '{}' })).rejects.toThrow(/Stripe-Signature/);
      await expect(provider([], { webhookSecret: undefined }).stripe.parseWebhook(signed(completed))).rejects.toThrow(
        /not configured/,
      );
    });

    it.each([
      ['payment_intent.payment_failed', { id: 'pi_1', amount: 10, currency: 'brl' }, 'payment.failed'],
      ['checkout.session.expired', { id: 'cs_1' }, 'payment.expired'],
      [
        'charge.refunded',
        { id: 'ch_1', payment_intent: 'pi_1', amount: 100, amount_refunded: 40 },
        'payment.partially_refunded',
      ],
      [
        'charge.refunded',
        { id: 'ch_1', payment_intent: 'pi_1', amount: 100, amount_refunded: 100 },
        'payment.refunded',
      ],
      ['customer.created', { id: 'cus_1' }, 'unknown'],
    ])('maps %s', async (type, object, expected) => {
      const event = await provider().stripe.parseWebhook(signed({ id: 'evt', type, data: { object } }));
      expect(event.type).toBe(expected);
    });
  });
});
