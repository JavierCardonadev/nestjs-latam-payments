import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentValidationError, UnsupportedOperationError, WebhookVerificationError } from '../../src/core/errors.js';
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

const subscription = {
  id: 'sub_1',
  object: 'subscription',
  status: 'active',
  created: 1_757_000_000,
  cancel_at_period_end: false,
  canceled_at: null,
  pause_collection: null,
  metadata: { reference: 'TENANT-7' },
  customer: 'cus_1',
  // API 2025-03 (basil) and later: billing period on the item.
  items: {
    data: [
      {
        quantity: 2,
        current_period_end: 1_760_000_000,
        price: {
          id: 'price_1',
          unit_amount: 49900,
          currency: 'mxn',
          recurring: { interval: 'month', interval_count: 1 },
        },
      },
    ],
  },
};

describe('StripeProvider subscriptions', () => {
  it('creates a recurring price as a plan', async () => {
    const { stripe, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/prices',
        body: {
          id: 'price_9',
          active: true,
          unit_amount: 29900,
          currency: 'mxn',
          recurring: { interval: 'month', interval_count: 3 },
          metadata: { trial_days: '14' },
          product: { id: 'prod_1', name: 'Pro' },
        },
      },
    ]);
    const plan = await stripe.createPlan({
      name: 'Pro',
      amount: 29900,
      currency: 'mxn',
      interval: 'month',
      intervalCount: 3,
      trialDays: 14,
      idempotencyKey: 'plan-pro',
    });
    expect(plan).toMatchObject({
      provider: 'stripe',
      id: 'price_9',
      name: 'Pro',
      amount: 29900,
      currency: 'MXN',
      interval: 'month',
      intervalCount: 3,
      trialDays: 14,
      active: true,
    });
    const form = Object.fromEntries(calls[0].form());
    expect(form).toMatchObject({
      currency: 'mxn',
      unit_amount: '29900',
      'recurring[interval]': 'month',
      'recurring[interval_count]': '3',
      'product_data[name]': 'Pro',
      'metadata[trial_days]': '14',
      'expand[0]': 'product',
    });
    expect(calls[0].headers['Idempotency-Key']).toBe('plan-pro');
  });

  it('validates plans', async () => {
    const { stripe } = provider();
    await expect(
      stripe.createPlan({ name: 'x', amount: 100, currency: 'USD', interval: 'month', totalCycles: 12 }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      stripe.createPlan({ name: 'x', amount: 100, currency: 'USD', interval: 'hour' as 'day' }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      stripe.createPlan({ name: 'x', amount: 100, currency: 'USD', interval: 'day', intervalCount: 0 }),
    ).rejects.toThrow('intervalCount must be an integer >= 1');
  });

  it('starts a subscription Checkout from a plan id, applying its default trial', async () => {
    const { stripe, calls } = provider([
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/prices/price_9',
        body: { id: 'price_9', unit_amount: 29900, currency: 'mxn', metadata: { trial_days: '7' }, product: 'prod_1' },
      },
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        body: { id: 'cs_sub', url: 'https://checkout.stripe.com/c/cs_sub' },
      },
    ]);
    const session = await stripe.createSubscription({
      reference: 'TENANT-7',
      plan: 'price_9',
      customer: { email: 'ana@test.mx' },
      successUrl: 'https://app.test/billing',
    });
    expect(session).toMatchObject({ id: 'cs_sub', reference: 'TENANT-7', url: 'https://checkout.stripe.com/c/cs_sub' });
    expect(Object.fromEntries(calls[1].form())).toMatchObject({
      mode: 'subscription',
      client_reference_id: 'TENANT-7',
      customer_email: 'ana@test.mx',
      'line_items[0][price]': 'price_9',
      'subscription_data[metadata][reference]': 'TENANT-7',
      'subscription_data[trial_period_days]': '7',
    });
  });

  it('starts a subscription with an inline plan', async () => {
    const { stripe, calls } = provider([
      { method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions', body: { id: 'cs_2', url: 'u' } },
    ]);
    await stripe.createSubscription({
      reference: 'T-1',
      plan: { name: 'Basic', amount: 900, currency: 'usd', interval: 'year' },
      successUrl: 'https://app.test',
    });
    const form = Object.fromEntries(calls[0].form());
    expect(form).toMatchObject({
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '900',
      'line_items[0][price_data][recurring][interval]': 'year',
      'line_items[0][price_data][product_data][name]': 'Basic',
    });
    expect(form['subscription_data[trial_period_days]']).toBeUndefined();
    await expect(stripe.createSubscription({ reference: 'T-1', plan: 'price_1' })).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
  });

  it('maps subscriptions, including the basil item billing period', async () => {
    const { stripe } = provider([
      { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/sub_1', body: subscription },
    ]);
    expect(await stripe.getSubscription('sub_1')).toEqual({
      provider: 'stripe',
      id: 'sub_1',
      reference: 'TENANT-7',
      status: 'active',
      planId: 'price_1',
      amount: 99800,
      currency: 'MXN',
      interval: 'month',
      intervalCount: 1,
      currentPeriodEnd: new Date(1_760_000_000_000),
      nextBillingAt: new Date(1_760_000_000_000),
      cancelAtPeriodEnd: false,
      canceledAt: undefined,
      customerEmail: undefined,
      createdAt: new Date(1_757_000_000_000),
      raw: subscription,
    });
  });

  it('resolves a Checkout Session to its subscription, or reports it pending', async () => {
    const { stripe, calls } = provider([
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/checkout/sessions/cs_done',
        body: { id: 'cs_done', subscription },
      },
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/checkout/sessions/cs_open',
        body: { id: 'cs_open', status: 'open', client_reference_id: 'T-2', created: 1_757_000_000 },
      },
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/checkout/sessions/cs_old',
        body: { id: 'cs_old', status: 'expired', metadata: { reference: 'T-3' } },
      },
    ]);
    expect(await stripe.getSubscription('cs_done')).toMatchObject({ id: 'sub_1', status: 'active' });
    expect(calls[0].url.searchParams.get('expand[0]')).toBe('subscription');
    expect(await stripe.getSubscription('cs_open')).toMatchObject({
      id: 'cs_open',
      status: 'pending',
      reference: 'T-2',
    });
    expect(await stripe.getSubscription('cs_old')).toMatchObject({ status: 'expired', reference: 'T-3' });
  });

  it('finds subscriptions by reference', async () => {
    const { stripe, calls } = provider([
      { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/search', body: { data: [subscription] } },
    ]);
    expect(await stripe.findSubscriptionByReference("it's")).toMatchObject({ id: 'sub_1' });
    expect(calls[0].url.searchParams.get('query')).toBe("metadata['reference']:'it\\'s'");

    const empty = provider([
      { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/search', body: { data: [] } },
    ]);
    expect(await empty.stripe.findSubscriptionByReference('none')).toBeNull();
  });

  it('cancels now or at period end', async () => {
    const { stripe, calls } = provider([
      {
        method: 'DELETE',
        url: 'https://api.stripe.com/v1/subscriptions/sub_1',
        body: { ...subscription, status: 'canceled', canceled_at: 1_758_000_000 },
      },
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/subscriptions/sub_1',
        body: { ...subscription, cancel_at_period_end: true },
      },
    ]);
    expect(await stripe.cancelSubscription({ subscriptionId: 'sub_1', reason: 'too expensive' })).toMatchObject({
      status: 'canceled',
      canceledAt: new Date(1_758_000_000_000),
      nextBillingAt: undefined,
    });
    expect(calls[0].url.searchParams.get('cancellation_details[comment]')).toBe('too expensive');

    expect(await stripe.cancelSubscription({ subscriptionId: 'sub_1', atPeriodEnd: true })).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      nextBillingAt: undefined,
    });
    expect(calls[1].body).toBe('cancel_at_period_end=true');
  });

  it('pauses and resumes collection', async () => {
    const { stripe, calls } = provider([
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/subscriptions/sub_1',
        body: { ...subscription, pause_collection: { behavior: 'void' } },
      },
    ]);
    expect(await stripe.pauseSubscription('sub_1')).toMatchObject({ status: 'paused' });
    expect(calls[0].form().get('pause_collection[behavior]')).toBe('void');
    await stripe.resumeSubscription('sub_1');
    expect(calls[1].body).toBe('pause_collection=');
  });

  it('maps customer.subscription webhooks', async () => {
    const { stripe } = provider();
    const created = await stripe.parseWebhook(
      signed({ id: 'evt_1', type: 'customer.subscription.created', created: 1, data: { object: subscription } }),
    );
    expect(created).toMatchObject({
      type: 'subscription.activated',
      subscriptionId: 'sub_1',
      reference: 'TENANT-7',
      amount: 99800,
      currency: 'MXN',
      status: undefined,
      subscription: { status: 'active' },
    });

    const trialing = await stripe.parseWebhook(
      signed({
        id: 'evt_t',
        type: 'customer.subscription.created',
        data: { object: { ...subscription, status: 'trialing', trial_end: 1_758_000_000 } },
      }),
    );
    expect(trialing).toMatchObject({ type: 'subscription.activated', subscription: { status: 'trialing' } });
    expect(trialing.subscription?.nextBillingAt).toEqual(new Date(1_758_000_000_000));

    const pastDue = await stripe.parseWebhook(
      signed({
        id: 'evt_2',
        type: 'customer.subscription.updated',
        data: { object: { ...subscription, status: 'past_due' }, previous_attributes: { status: 'active' } },
      }),
    );
    expect(pastDue.type).toBe('subscription.past_due');

    const quantity = await stripe.parseWebhook(
      signed({
        id: 'evt_3',
        type: 'customer.subscription.updated',
        data: { object: subscription, previous_attributes: { quantity: 1 } },
      }),
    );
    expect(quantity.type).toBe('subscription.updated');

    const paused = await stripe.parseWebhook(
      signed({
        id: 'evt_p',
        type: 'customer.subscription.updated',
        data: {
          object: { ...subscription, pause_collection: { behavior: 'void' } },
          previous_attributes: { pause_collection: null },
        },
      }),
    );
    expect(paused.type).toBe('subscription.paused');

    const deleted = await stripe.parseWebhook(
      signed({
        id: 'evt_4',
        type: 'customer.subscription.deleted',
        data: { object: { ...subscription, status: 'canceled' } },
      }),
    );
    expect(deleted.type).toBe('subscription.canceled');

    const resumed = await stripe.parseWebhook(
      signed({ id: 'evt_5', type: 'customer.subscription.resumed', data: { object: subscription } }),
    );
    expect(resumed.type).toBe('subscription.activated');

    const trialEnding = await stripe.parseWebhook(
      signed({ id: 'evt_6', type: 'customer.subscription.trial_will_end', data: { object: subscription } }),
    );
    expect(trialEnding).toMatchObject({ type: 'unknown', subscriptionId: 'sub_1' });
  });

  it('maps invoice webhooks for new and legacy API versions', async () => {
    const { stripe } = provider();
    const paid = await stripe.parseWebhook(
      signed({
        id: 'evt_7',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_1',
            amount_paid: 99800,
            amount_due: 99800,
            currency: 'mxn',
            parent: { subscription_details: { subscription: 'sub_1', metadata: { reference: 'TENANT-7' } } },
          },
        },
      }),
    );
    expect(paid).toMatchObject({
      type: 'subscription.payment_succeeded',
      paymentId: 'in_1',
      subscriptionId: 'sub_1',
      reference: 'TENANT-7',
      amount: 99800,
      currency: 'MXN',
    });

    const failed = await stripe.parseWebhook(
      signed({
        id: 'evt_8',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_2',
            amount_due: 500,
            currency: 'usd',
            subscription: { id: 'sub_legacy' },
            subscription_details: { metadata: { reference: 'T-9' } },
          },
        },
      }),
    );
    expect(failed).toMatchObject({
      type: 'subscription.payment_failed',
      subscriptionId: 'sub_legacy',
      reference: 'T-9',
      amount: 500,
    });

    const oneOff = await stripe.parseWebhook(
      signed({ id: 'evt_9', type: 'invoice.paid', data: { object: { id: 'in_3', amount_paid: 1, currency: 'usd' } } }),
    );
    expect(oneOff).toMatchObject({ type: 'unknown', subscriptionId: undefined });
  });

  it('does not report subscription Checkout completions as one-off payments', async () => {
    const { stripe } = provider();
    const event = await stripe.parseWebhook(
      signed({
        id: 'evt_10',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_sub', mode: 'subscription', subscription: 'sub_1', client_reference_id: 'TENANT-7' },
        },
      }),
    );
    expect(event).toMatchObject({
      type: 'unknown',
      subscriptionId: 'sub_1',
      reference: 'TENANT-7',
      paymentId: undefined,
    });
  });
});
