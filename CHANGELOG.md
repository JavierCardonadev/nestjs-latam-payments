# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-13

### Added

- Subscriptions for Stripe, Mercado Pago and PayPal: `createPlan`, `getPlan`, `createSubscription`, `getSubscription`, `findSubscriptionByReference`, `cancelSubscription`, `pauseSubscription` and `resumeSubscription`, with inline plans, trials and billing cycles where each provider supports them.
- `subscription.*` events (`pending`, `activated`, `updated`, `past_due`, `paused`, `canceled`, `expired`, `payment_succeeded`, `payment_failed`) with `event.subscriptionId` and `event.subscription`, from `customer.subscription.*`/`invoice.*` (Stripe), `subscription_preapproval`/`subscription_authorized_payment` (Mercado Pago) and `BILLING.SUBSCRIPTION.*`/`PAYMENT.SALE.*` (PayPal).
- Optional `subscriptions` capability and subscription methods on the `PaymentProvider` interface.

### Changed

- Stripe `checkout.session.*` events in subscription mode are no longer reported as one-off `payment.*` events.

## [0.1.0] - 2026-09-13

### Added

- `PaymentsModule.forRoot` / `forRootAsync` for NestJS 11 and 12, `PaymentsService`, `@OnPaymentEvent` handlers, `events$` observable and a webhook controller at `POST /payments/webhooks/:provider`.
- Providers: Wompi, Mercado Pago, PayU LATAM, Stripe and PayPal — checkout, get payment, find by reference, refunds, PayPal capture and verified webhooks.
- Normalized payment model with integer minor units and ISO 4217 helpers.
- `createProviderRegistry` and standalone adapters for use without NestJS.
