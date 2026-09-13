# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-13

### Added

- `PaymentsModule.forRoot` / `forRootAsync` for NestJS 11 and 12, `PaymentsService`, `@OnPaymentEvent` handlers, `events$` observable and a webhook controller at `POST /payments/webhooks/:provider`.
- Providers: Wompi, Mercado Pago, PayU LATAM, Stripe and PayPal — checkout, get payment, find by reference, refunds, PayPal capture and verified webhooks.
- Normalized payment model with integer minor units and ISO 4217 helpers.
- `createProviderRegistry` and standalone adapters for use without NestJS.
