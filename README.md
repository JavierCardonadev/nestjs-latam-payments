# nestjs-latam-payments

[![CI](https://github.com/JavierCardonadev/nestjs-latam-payments/actions/workflows/ci.yml/badge.svg)](https://github.com/JavierCardonadev/nestjs-latam-payments/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nestjs-latam-payments.svg)](https://www.npmjs.com/package/nestjs-latam-payments)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One NestJS module for Wompi, Mercado Pago, PayU LATAM, Stripe and PayPal.**
Create checkouts and subscriptions, verify webhooks, query and refund payments through a single normalized API — with signature verification checked against each provider's official test vectors.

> 🇪🇸 [Leer en español](README.es.md)

```ts
@OnPaymentEvent('payment.succeeded')
async markPaid(event: PaymentEvent) {
  await this.orders.markPaid(event.reference, event.amount, event.currency);
}
```

## Why

Selling in Latin America usually means integrating two or three gateways: a local one (Wompi in Colombia, Mercado Pago in Argentina/Mexico/Brazil, PayU across the region) plus Stripe or PayPal for international cards. Each one signs webhooks differently, uses different amount formats and status names, and has its own gotchas. This module hides all of that behind one interface.

- **One model**: amounts in integer minor units + ISO 4217 currency, normalized payment and subscription statuses and events.
- **One-off payments and subscriptions**: plans, trials, pause/resume, cancel, and renewal charge events.
- **Webhooks done right**: HMAC / RSA verification over the raw body, constant-time comparison, replay tolerance, status never trusted from unsigned payloads.
- **Zero runtime dependencies**: native `fetch` and `node:crypto`. No provider SDKs.
- **NestJS 11 and 12**, or use the adapters standalone in Express, Fastify, workers.
- **Extensible**: implement `PaymentProvider` to add any gateway.

## Providers

| Provider         | Countries            | Checkout                      | Webhook verification                   | Get | Find by reference | Refund    | Partial refund | Subscriptions |
| ---------------- | -------------------- | ----------------------------- | -------------------------------------- | --- | ----------------- | --------- | -------------- | ------------- |
| **Wompi**        | 🇨🇴                   | Web Checkout (redirect)       | SHA-256 checksum + integrity signature | ✅  | —                 | ✅ (void) | —              | —             |
| **Mercado Pago** | 🇦🇷 🇧🇷 🇲🇽 🇨🇴 🇨🇱 🇵🇪 🇺🇾 | Checkout Pro                  | `x-signature` HMAC + API re-fetch      | ✅  | ✅                | ✅        | ✅             | ✅            |
| **PayU LATAM**   | 🇨🇴 🇲🇽 🇦🇷 🇧🇷 🇨🇱 🇵🇪 🇵🇦 | WebCheckout (POST form)       | MD5 / SHA-1 / SHA-256 `sign`           | ✅  | ✅                | ✅        | ✅             | —             |
| **Stripe**       | 🌎 (incl. 🇲🇽 🇧🇷)     | Checkout Sessions             | `Stripe-Signature` HMAC + tolerance    | ✅  | ✅                | ✅        | ✅             | ✅            |
| **PayPal**       | 🌎                   | Orders v2 (approve + capture) | RSA certificate self-verification      | ✅  | —                 | ✅        | ✅             | ✅            |

**Roadmap** (contributions welcome — see [issues](https://github.com/JavierCardonadev/nestjs-latam-payments/issues?q=label%3Aprovider)): dLocal, EBANX, Kushki, Conekta, Culqi, OpenPay, ePayco, Transbank Webpay, PagBank.

## Install

```bash
npm install nestjs-latam-payments
```

Requires Node.js ≥ 20.19 and `@nestjs/common` / `@nestjs/core` 11 or 12. The package is ESM; CommonJS Nest apps can load it on Node ≥ 20.19.

## Quick start

### 1. Register the module

```ts
import { Module } from '@nestjs/common';
import { PaymentsModule } from 'nestjs-latam-payments';

@Module({
  imports: [
    PaymentsModule.forRoot({
      defaultProvider: 'wompi',
      providers: {
        wompi: {
          publicKey: process.env.WOMPI_PUBLIC_KEY!,
          privateKey: process.env.WOMPI_PRIVATE_KEY!,
          integritySecret: process.env.WOMPI_INTEGRITY_SECRET!,
          eventsSecret: process.env.WOMPI_EVENTS_SECRET!,
        },
        stripe: {
          secretKey: process.env.STRIPE_SECRET_KEY!,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        },
      },
    }),
  ],
})
export class AppModule {}
```

With `ConfigService`:

```ts
PaymentsModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: {
      mercadopago: {
        accessToken: config.getOrThrow('MP_ACCESS_TOKEN'),
        webhookSecret: config.get('MP_WEBHOOK_SECRET'),
      },
    },
  }),
});
```

### 2. Enable the raw body

Webhook signatures are computed over the exact bytes the provider sent, so Nest must keep them:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

### 3. Create a checkout

```ts
@Controller('orders')
export class OrdersController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/pay')
  async pay(@Param('id') id: string) {
    const session = await this.payments.createCheckout({
      amount: 15_000_000, // 150,000.00 COP — always minor units
      currency: 'COP',
      reference: id, // your order id; comes back in every event
      description: 'Order #' + id,
      customer: { email: 'buyer@example.com' },
      successUrl: 'https://shop.example.com/orders/' + id,
    });

    return session.url
      ? { redirectUrl: session.url } // Wompi, Mercado Pago, Stripe, PayPal
      : { form: session.form }; // PayU: render with renderCheckoutForm(session.form)
  }
}
```

Pick a provider per call: `createCheckout(request, 'paypal')`.

### 4. React to events

The module mounts `POST /payments/webhooks/:provider`. Every request is verified, normalized and dispatched to your handlers:

```ts
@Injectable()
export class PaymentListener {
  @OnPaymentEvent('payment.succeeded')
  async markPaid(event: PaymentEvent) {
    // event.provider, event.reference, event.amount (minor units), event.currency, event.payment, event.raw
  }

  @OnPaymentEvent(['payment.failed', 'payment.expired'])
  async release(event: PaymentEvent) {}
}
```

- Invalid signature → **400** (the event is dropped).
- A handler throws → **500**, so the provider retries. Make handlers idempotent with `event.id`.
- Unknown provider → **404**.

Prefer RxJS? `paymentEvents.events$.subscribe(...)`.

## Subscriptions

Define a plan once, then send each customer to authorize it. Renewals, failures and cancellations arrive as `subscription.*` events on the same webhook endpoint.

```ts
// Once (or create it in the provider dashboard and use its id).
const plan = await payments.createPlan(
  { name: 'Pro', amount: 4_990_000, currency: 'COP', interval: 'month', trialDays: 14 },
  'mercadopago',
);

// Per customer.
const session = await payments.createSubscription(
  {
    reference: tenant.id, // comes back on every subscription event
    plan: plan.id, // or an inline plan on Stripe and Mercado Pago
    customer: { email: user.email },
    successUrl: 'https://app.example.com/billing',
  },
  'mercadopago',
);
return { redirectUrl: session.url };
```

```ts
@Injectable()
export class BillingListener {
  @OnPaymentEvent(['subscription.activated', 'subscription.payment_succeeded'])
  async grantAccess(event: PaymentEvent) {
    await this.tenants.activate(event.reference, event.subscriptionId);
  }

  @OnPaymentEvent(['subscription.past_due', 'subscription.payment_failed'])
  async warn(event: PaymentEvent) {}

  @OnPaymentEvent(['subscription.canceled', 'subscription.expired'])
  async revokeAccess(event: PaymentEvent) {}
}
```

Manage them later:

```ts
await payments.getSubscription('stripe', 'sub_123');
await payments.findSubscriptionByReference('mercadopago', tenant.id);
await payments.cancelSubscription('stripe', { subscriptionId: 'sub_123', atPeriodEnd: true });
await payments.pauseSubscription('paypal', 'I-BW452GLLEP1G');
await payments.resumeSubscription('paypal', 'I-BW452GLLEP1G');
```

|                                     | Stripe                         | Mercado Pago                                 | PayPal                         |
| ----------------------------------- | ------------------------------ | -------------------------------------------- | ------------------------------ |
| Plan                                | Recurring Price (`price_…`)    | Preapproval plan                             | Product + billing plan (`P-…`) |
| Inline plan in `createSubscription` | ✅                             | ✅                                           | — (plan id required)           |
| Intervals                           | day, week, month, year         | day, week, month, year (sent as days/months) | day, week, month, year         |
| Trial days                          | ✅                             | ✅                                           | ✅ (≤ 365)                     |
| `totalCycles`                       | — (use Subscription Schedules) | ✅                                           | ✅                             |
| Customer authorizes at              | Stripe Checkout                | Mercado Pago (any saved method)              | PayPal                         |
| Find by reference                   | ✅ Search API                  | ✅                                           | — (store the id)               |
| Cancel at period end                | ✅                             | — (immediate)                                | — (immediate)                  |
| Pause / resume                      | ✅ (`pause_collection`)        | ✅                                           | ✅ (suspend / activate)        |

`subscription.activated` is emitted when a subscription becomes active or trialing — including after a resume — so handlers should be idempotent. Wompi and PayU don't offer hosted recurring billing; calling these methods on them throws `UnsupportedOperationError`.

## Webhook URLs

| Provider     | Configure this URL                               | Where                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wompi        | `https://your.app/payments/webhooks/wompi`       | Dashboard → Developers → Events URL                                                                                                                                                                        |
| Mercado Pago | `https://your.app/payments/webhooks/mercadopago` | Your integrations → Webhooks. Topics: Payments, and Plans and subscriptions (`subscription_preapproval`, `subscription_authorized_payment`). Also sent as `notification_url` if you pass `notificationUrl` |
| PayU         | `https://your.app/payments/webhooks/payu`        | Sent per transaction as `confirmationUrl` — pass `notificationUrl`                                                                                                                                         |
| Stripe       | `https://your.app/payments/webhooks/stripe`      | Developers → Webhooks. Events: `checkout.session.*`, `payment_intent.*`, `charge.refunded`; subscriptions: `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`                             |
| PayPal       | `https://your.app/payments/webhooks/paypal`      | App → Webhooks. Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*`; subscriptions: `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.DENIED`                                           |

Change the base path with `PaymentsModule.forRoot({ ...options, webhooks: { path: 'hooks/pay' } })`, or disable the controller with `{ webhooks: false }` and call `payments.handleWebhook(provider, { headers, rawBody })` yourself.

## Normalized model

**Payment statuses**: `pending`, `requires_action`, `authorized`, `succeeded`, `failed`, `canceled`, `expired`, `refunded`, `partially_refunded`.

**Events**: `payment.pending`, `payment.authorized`, `payment.succeeded`, `payment.failed`, `payment.canceled`, `payment.expired`, `payment.refunded`, `payment.partially_refunded`.

**Subscription statuses**: `pending`, `trialing`, `active`, `past_due`, `paused`, `canceled`, `expired`.

**Subscription events**: `subscription.pending`, `subscription.activated`, `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.canceled`, `subscription.expired`, `subscription.payment_succeeded`, `subscription.payment_failed` — with `event.subscriptionId` and, when available, `event.subscription`.

Provider events outside these lifecycles arrive as `unknown` (always available in `event.providerType` / `event.raw`).

**Money**: integers in the currency's minor unit. `toMinorUnits('150000.50', 'COP')` → `15000050`; `toDecimalString(15000050, 'COP')` → `'150000.50'`. Zero-decimal (CLP, JPY…) and three-decimal (KWD…) currencies are handled.

## API

```ts
payments.createCheckout(request, provider?)       // CheckoutSession { id, url?, form?, raw }
payments.getPayment(provider, paymentId)          // Payment
payments.findByReference(provider, reference)     // Payment | null
payments.refund(provider, { paymentId, amount?, reason? })
payments.capture('paypal', orderId)

payments.createPlan(request, provider?)           // Plan
payments.getPlan(provider, planId)
payments.createSubscription(request, provider?)   // SubscriptionSession { id, url, raw }
payments.getSubscription(provider, subscriptionId)
payments.findSubscriptionByReference(provider, reference)
payments.cancelSubscription(provider, { subscriptionId, atPeriodEnd?, reason? })
payments.pauseSubscription(provider, subscriptionId)
payments.resumeSubscription(provider, subscriptionId)
payments.provider('stripe')                       // the raw adapter
```

Errors extend `PaymentsError`: `ProviderError` (HTTP/API failures, with `httpStatus`, `code`, `raw`), `WebhookVerificationError`, `UnsupportedOperationError`, `PaymentValidationError`, `PaymentsConfigurationError`.

### Without NestJS

```ts
import { WompiProvider } from 'nestjs-latam-payments';

const wompi = new WompiProvider({ publicKey, privateKey, integritySecret, eventsSecret });
const session = await wompi.createCheckout({ amount: 5_000_000, currency: 'COP', reference: 'A-1' });

app.post('/webhooks/wompi', express.raw({ type: '*/*' }), async (req, res) => {
  const event = await wompi.parseWebhook({ headers: req.headers, rawBody: req.body });
  res.sendStatus(200);
});
```

## Provider notes

- **Wompi** only settles in COP; refunds are full voids (card payments). Sandbox vs production is inferred from the key prefix and a mismatch is rejected.
- **Mercado Pago** notifications carry no status, so the payment is re-fetched from the API (`hydrateWebhooks: true`, default). Configure `webhookSecret` to verify `x-signature`.
- **PayU** WebCheckout is an HTML POST form; `renderCheckoutForm(session.form)` returns an auto-submitting page. Confirmation signatures are verified with the algorithm PayU used.
- **Stripe** requires `successUrl`. `reference` is stored as `client_reference_id` and metadata, so `findByReference` works through the Search API.
- **PayPal** approvals are captured automatically when the `CHECKOUT.ORDER.APPROVED` webhook arrives (`autoCaptureOnApproval: false` to disable). Webhooks are verified locally against PayPal's certificate; certificate URLs outside `api(-m)(.sandbox).paypal.com` are rejected.

More detail in [docs/providers.md](docs/providers.md).

## Adding a provider

Implement the `PaymentProvider` interface and pass it in `customProviders`. The guide is in [docs/adding-a-provider.md](docs/adding-a-provider.md) — PRs for roadmap gateways are very welcome.

## Development

```bash
npm install
npm test          # unit + e2e (no network)
npm run test:live # hits PayU's public sandbox
npm run lint && npm run typecheck && npm run build
```

A runnable example lives in [examples/nest-app](examples/nest-app).

## Need help integrating payments in Latin America?

I'm Javier Cardona, a full-stack developer based in Colombia and the author of this module. I help companies launch and fix payment flows: gateway selection, checkout, webhooks and reconciliation, subscriptions, multi-country setups and migrations between providers.

👉 **[javiercardona.dev](https://javiercardona.dev)** — or open an [integration help issue](https://github.com/JavierCardonadev/nestjs-latam-payments/issues/new?template=integration-help.yml).

## License

[MIT](LICENSE) © Javier Cardona. Not affiliated with any of the payment providers mentioned.
