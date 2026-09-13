import { createHash, createHmac } from 'node:crypto';
import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentsConfigurationError, UnsupportedOperationError } from '../../src/core/errors.js';
import type { PaymentEvent } from '../../src/core/types.js';
import { OnPaymentEvent, PaymentEventsService } from '../../src/nest/payment-events.service.js';
import { PaymentsModule } from '../../src/nest/payments.module.js';
import { PaymentsService } from '../../src/nest/payments.service.js';
import { createProviderRegistry } from '../../src/registry.js';
import { mockFetch } from '../helpers/mock-fetch.js';

const wompiConfig = {
  publicKey: 'pub_test_abc',
  privateKey: 'prv_test_xyz',
  integritySecret: 'test_integrity_secret',
  eventsSecret: 'test_events_secret',
};

function wompiEvent(status: string, secret = wompiConfig.eventsSecret) {
  const transaction = { id: 'tx-1', status, amount_in_cents: 5_000_000, reference: 'ORDER-1', currency: 'COP' };
  const timestamp = 1_757_764_800;
  return {
    event: 'transaction.updated',
    data: { transaction },
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: createHash('sha256').update(`tx-1${status}5000000${timestamp}${secret}`).digest('hex'),
    },
    timestamp,
  };
}

@Injectable()
class OrdersListener {
  readonly paid: PaymentEvent[] = [];
  readonly all: PaymentEvent[] = [];
  failNext = false;

  @OnPaymentEvent('payment.succeeded')
  async onPaid(event: PaymentEvent) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database down');
    }
    this.paid.push(event);
  }

  @OnPaymentEvent()
  onAny(event: PaymentEvent) {
    this.all.push(event);
  }
}

@Injectable()
class BillingListener {
  readonly activated: PaymentEvent[] = [];
  readonly charges: PaymentEvent[] = [];

  @OnPaymentEvent('subscription.activated')
  onActivated(event: PaymentEvent) {
    this.activated.push(event);
  }

  @OnPaymentEvent(['subscription.payment_succeeded', 'subscription.payment_failed'])
  onCharge(event: PaymentEvent) {
    this.charges.push(event);
  }
}

describe('PaymentsModule', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(module: ReturnType<typeof PaymentsModule.forRoot>) {
    const ref = await Test.createTestingModule({ imports: [module], providers: [OrdersListener] }).compile();
    app = ref.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    return { app, listener: ref.get(OrdersListener), payments: ref.get(PaymentsService) };
  }

  it('verifies webhooks end-to-end and dispatches @OnPaymentEvent handlers', async () => {
    const { app, listener } = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig } }));

    const res = await request(app.getHttpServer())
      .post('/payments/webhooks/wompi')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(wompiEvent('APPROVED')));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, type: 'payment.succeeded' });
    expect(listener.paid).toHaveLength(1);
    expect(listener.paid[0]).toMatchObject({ reference: 'ORDER-1', amount: 5_000_000 });
    expect(listener.all).toHaveLength(1);
  });

  it('answers 400 on invalid signatures without running handlers', async () => {
    const { app, listener } = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig } }));
    const res = await request(app.getHttpServer())
      .post('/payments/webhooks/wompi')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(wompiEvent('APPROVED', 'forged')));
    expect(res.status).toBe(400);
    expect(listener.all).toHaveLength(0);
  });

  it('answers 500 when a handler fails so the provider retries', async () => {
    const { app, listener } = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig } }));
    listener.failNext = true;
    const res = await request(app.getHttpServer())
      .post('/payments/webhooks/wompi')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(wompiEvent('APPROVED')));
    expect(res.status).toBe(500);
  });

  it('answers 404 for providers that are not configured', async () => {
    const { app } = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig } }));
    const res = await request(app.getHttpServer()).post('/payments/webhooks/stripe').send({});
    expect(res.status).toBe(404);
  });

  it('supports a custom webhook path and disabling the controller', async () => {
    let booted = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig }, webhooks: { path: 'hooks' } }));
    expect(
      (
        await request(booted.app.getHttpServer())
          .post('/hooks/wompi')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(wompiEvent('DECLINED')))
      ).status,
    ).toBe(200);
    await booted.app.close();

    booted = await boot(PaymentsModule.forRoot({ providers: { wompi: wompiConfig }, webhooks: false }));
    expect((await request(booted.app.getHttpServer()).post('/payments/webhooks/wompi').send({})).status).toBe(404);
  });

  it('configures asynchronously and resolves the default provider', async () => {
    const mock = mockFetch([
      {
        url: 'https://sandbox.wompi.co/v1/transactions/tx-1',
        body: { data: { id: 'tx-1', status: 'APPROVED', amount_in_cents: 100, reference: 'r', currency: 'COP' } },
      },
    ]);
    const { payments } = await boot(
      PaymentsModule.forRootAsync({
        useFactory: async () => ({
          providers: { wompi: { ...wompiConfig, http: { fetch: mock.fetch } } },
          defaultProvider: 'wompi',
        }),
      }),
    );
    expect(payments.providerNames).toEqual(['wompi']);
    expect(payments.provider().name).toBe('wompi');
    expect(await payments.getPayment('wompi', 'tx-1')).toMatchObject({ status: 'succeeded' });
    await expect(payments.capture('wompi', 'tx-1')).rejects.toThrow(/does not support capture/);
  });

  it('exposes an observable stream and programmatic subscriptions', async () => {
    const ref = await Test.createTestingModule({
      imports: [PaymentsModule.forRoot({ providers: { wompi: wompiConfig }, webhooks: false })],
    }).compile();
    await ref.init();
    const events = ref.get(PaymentEventsService);
    const payments = ref.get(PaymentsService);
    const seen = vi.fn();
    const handler = vi.fn();
    events.events$.subscribe(seen);
    const off = events.on(['payment.failed'], handler);

    const body = JSON.stringify(wompiEvent('DECLINED'));
    await payments.handleWebhook('wompi', { headers: {}, rawBody: body });
    off();
    await payments.handleWebhook('wompi', { headers: {}, rawBody: body });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(2);
    await ref.close();
  });

  it('auto-captures PayPal approvals', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        PaymentsModule.forRoot({
          providers: { paypal: { clientId: 'a', clientSecret: 'b', webhookId: 'WH' } },
          webhooks: false,
        }),
      ],
    }).compile();
    const payments = ref.get(PaymentsService);
    const paypal = payments.provider('paypal') as any;
    vi.spyOn(paypal, 'parseWebhook').mockResolvedValue({
      provider: 'paypal',
      id: 'e',
      type: 'payment.authorized',
      providerType: 'CHECKOUT.ORDER.APPROVED',
      paymentId: 'O-1',
      raw: {},
    });
    const capture = vi
      .spyOn(paypal, 'capture')
      .mockResolvedValue({ provider: 'paypal', id: 'O-1', status: 'succeeded', raw: {} });

    const event = await payments.handleWebhook('paypal', { headers: {}, rawBody: '{}' });
    expect(capture).toHaveBeenCalledWith('O-1');
    expect(event.payment?.status).toBe('succeeded');
    await ref.close();
  });

  it('validates registry configuration', () => {
    expect(() => createProviderRegistry({})).toThrow(PaymentsConfigurationError);
    expect(() => createProviderRegistry({ providers: { wompi: wompiConfig }, defaultProvider: 'stripe' })).toThrow(
      /defaultProvider/,
    );
    expect(() =>
      createProviderRegistry({
        providers: { wompi: wompiConfig },
        customProviders: [{ name: 'wompi' } as any],
      }),
    ).toThrow(/duplicate/);
  });

  it('manages subscriptions through PaymentsService and dispatches subscription events', async () => {
    const sub = {
      id: 'sub_1',
      status: 'active',
      metadata: { reference: 'TENANT-1' },
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: 'price_1',
              unit_amount: 1000,
              currency: 'usd',
              recurring: { interval: 'month', interval_count: 1 },
            },
          },
        ],
      },
    };
    const mock = mockFetch([
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/prices',
        body: {
          id: 'price_1',
          unit_amount: 1000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        },
      },
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/prices/price_1',
        body: { id: 'price_1', unit_amount: 1000, currency: 'usd' },
      },
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        body: { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' },
      },
      { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/search', body: { data: [sub] } },
      { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/sub_1', body: sub },
      { method: 'DELETE', url: 'https://api.stripe.com/v1/subscriptions/sub_1', body: { ...sub, status: 'canceled' } },
      { method: 'POST', url: 'https://api.stripe.com/v1/subscriptions/sub_1', body: sub },
    ]);
    const secret = 'whsec_nest';
    const ref = await Test.createTestingModule({
      imports: [
        PaymentsModule.forRoot({
          providers: {
            wompi: wompiConfig,
            stripe: { secretKey: 'sk_test', webhookSecret: secret, http: { fetch: mock.fetch } },
          },
          defaultProvider: 'stripe',
        }),
      ],
      providers: [BillingListener],
    }).compile();
    app = ref.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    const payments = ref.get(PaymentsService);
    const listener = ref.get(BillingListener);

    const plan = await payments.createPlan({ name: 'Pro', amount: 1000, currency: 'USD', interval: 'month' });
    expect(plan.id).toBe('price_1');
    expect(await payments.getPlan('stripe', 'price_1')).toMatchObject({ amount: 1000 });
    expect(
      await payments.createSubscription({ reference: 'TENANT-1', plan: 'price_1', successUrl: 'https://app.test' }),
    ).toMatchObject({ url: 'https://checkout.stripe.com/cs_1' });
    expect(await payments.findSubscriptionByReference('stripe', 'TENANT-1')).toMatchObject({ id: 'sub_1' });
    expect(await payments.getSubscription('stripe', 'sub_1')).toMatchObject({ status: 'active' });
    expect(await payments.cancelSubscription('stripe', { subscriptionId: 'sub_1' })).toMatchObject({
      status: 'canceled',
    });
    expect(await payments.pauseSubscription('stripe', 'sub_1')).toMatchObject({ id: 'sub_1' });
    expect(await payments.resumeSubscription('stripe', 'sub_1')).toMatchObject({ id: 'sub_1' });

    await expect(payments.getSubscription('wompi', 'x')).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      payments.createPlan({ name: 'x', amount: 1, currency: 'COP', interval: 'month' }, 'wompi'),
    ).rejects.toThrow('wompi does not support subscriptions');

    const post = (event: unknown) => {
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
      return request(app!.getHttpServer())
        .post('/payments/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', `t=${t},v1=${v1}`)
        .send(payload);
    };
    const created = await post({ id: 'evt_1', type: 'customer.subscription.created', data: { object: sub } });
    expect(created.body).toEqual({ received: true, id: 'evt_1', type: 'subscription.activated' });
    await post({
      id: 'evt_2',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          amount_paid: 1000,
          currency: 'usd',
          parent: { subscription_details: { subscription: 'sub_1', metadata: { reference: 'TENANT-1' } } },
        },
      },
    }).expect(200);

    expect(listener.activated).toHaveLength(1);
    expect(listener.activated[0]).toMatchObject({ reference: 'TENANT-1', subscription: { planId: 'price_1' } });
    expect(listener.charges).toHaveLength(1);
    expect(listener.charges[0]).toMatchObject({ type: 'subscription.payment_succeeded', amount: 1000 });
  });
});
