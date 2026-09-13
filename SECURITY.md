# Security policy

This library verifies payment webhooks, so signature-bypass bugs are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/JavierCardonadev/nestjs-latam-payments/security/advisories/new).

Include the affected provider, version, and a proof of concept if possible. You will get an answer within 5 business days, and a fix for confirmed issues as soon as possible, credited to you unless you prefer otherwise.

## Supported versions

The latest minor release receives security fixes.

## Integration checklist

- Create the Nest app with `rawBody: true` and never re-serialize the body before verification.
- Configure every webhook secret (`eventsSecret`, `webhookSecret`, `webhookId`). Mercado Pago without a secret relies on API re-fetching only.
- Make `@OnPaymentEvent` handlers idempotent with `event.id` and compare `event.amount` / `event.currency` with your order before fulfilling it.
- Keep secrets in environment variables or a secret manager, never in the frontend. Only Wompi's `publicKey` is safe to expose.
