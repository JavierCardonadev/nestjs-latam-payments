# Provider reference

Configuration, status mapping and quirks of each built-in adapter. Every adapter accepts `http: { fetch?, timeoutMs? }` to inject a custom `fetch` (proxies, tests) or change the timeout.

## Wompi (Colombia)

```ts
wompi: {
  publicKey: 'pub_test_…',          // pub_prod_… in production
  privateKey: 'prv_test_…',         // query and void transactions
  integritySecret: 'test_integrity_…', // signs checkout links
  eventsSecret: 'test_events_…',    // verifies webhooks
  webhookToleranceSeconds: undefined, // optional replay window (off: Wompi retries for hours)
}
```

- **Checkout**: returns a signed `https://checkout.wompi.co/p/?…` URL. `signature:integrity` = `SHA256(reference + amountInCents + currency [+ expirationTime] + integritySecret)`, validated against Wompi's published example.
- **Currency**: COP only (others throw `PaymentValidationError`).
- **Environment**: inferred from the key prefixes; mixing `pub_test_` with `prv_prod_` throws at startup.
- **Webhooks**: `signature.checksum` (body or `X-Event-Checksum` header) = `SHA256(values of signature.properties + timestamp + eventsSecret)`. Event id is `${transactionId}:${status}:${timestamp}`.
- **Refunds**: `POST /transactions/{id}/void`, full amount only. `findByReference` is not supported by Wompi's public API.

| Wompi           | Normalized |
| --------------- | ---------- |
| PENDING         | pending    |
| APPROVED        | succeeded  |
| DECLINED, ERROR | failed     |
| VOIDED          | canceled   |

## Mercado Pago

```ts
mercadopago: {
  accessToken: 'APP_USR-…',   // or TEST-…
  webhookSecret: '…',         // "Secret signature" in Your integrations → Webhooks
  webhookToleranceSeconds: 300,
  hydrateWebhooks: true,      // default
  useSandboxInitPoint: false,
  statementDescriptor: 'MYSHOP',
}
```

- **Checkout**: Checkout Pro preference. `url` is `init_point` (or `sandbox_init_point`). `reference` → `external_reference`.
- **Webhooks**: `x-signature: ts=…,v1=…` verified as `HMAC-SHA256("id:{data.id};request-id:{x-request-id};ts:{ts};", secret)`, same manifest as the official SDK. Notifications carry no status, so the payment is fetched from `/v1/payments/{id}`. Configuring neither a secret nor hydration is rejected at startup.
- **Refunds**: full or partial, with `X-Idempotency-Key` (random unless you pass `idempotencyKey`).

| Mercado Pago                      | Normalized                                                          |
| --------------------------------- | ------------------------------------------------------------------- |
| pending, in_process, in_mediation | pending                                                             |
| authorized                        | authorized                                                          |
| approved                          | succeeded (partially_refunded if `transaction_amount_refunded` > 0) |
| rejected                          | failed                                                              |
| cancelled                         | canceled                                                            |
| refunded, charged_back            | refunded                                                            |

## PayU LATAM

```ts
payu: {
  apiKey: '…',
  apiLogin: '…',
  merchantId: '508029',
  accountId: '512321',        // one per country
  environment: 'production',  // default: sandbox
  signatureAlgorithm: 'sha256', // md5 | sha1 | sha256
  language: 'es',
}
```

- **Checkout**: WebCheckout is a POST form. `session.form = { action, method: 'POST', fields }`; serve it with `renderCheckoutForm(session.form)`. `signature` = `HASH(apiKey~merchantId~referenceCode~amount~currency)`, validated against PayU's official examples for MD5, SHA-1 and SHA-256. `successUrl` → `responseUrl`, `notificationUrl` → `confirmationUrl`.
- **Webhooks** (confirmation page, `application/x-www-form-urlencoded`): `sign` = `HASH(apiKey~merchant_id~reference_sale~new_value~currency~state_pol)` where `new_value` keeps one decimal when the second is zero (`150.00` → `150.0`). Algorithm detected from the signature length. `merchant_id` must match.
- **Queries**: Reports API `ORDER_DETAIL` (by order id) and `ORDER_DETAIL_BY_REFERENCE_CODE`.
- **Refunds**: `REFUND` / `PARTIAL_REFUND` on the approved transaction. PayU reviews refunds manually, so they usually come back `pending`.
- **Sandbox**: PayU's public test credentials work, but the sandbox does not validate form signatures — test signatures with the unit tests, not against the sandbox.

| `state_pol` | Normalized |
| ----------- | ---------- |
| 4           | succeeded  |
| 5           | expired    |
| 6, 104      | failed     |
| 7           | pending    |

## Stripe

```ts
stripe: {
  secretKey: 'sk_test_…',
  webhookSecret: 'whsec_…',
  webhookToleranceSeconds: 300,
  apiVersion: undefined,       // pin if you want
}
```

- **Checkout**: Checkout Session in `payment` mode with one line item. `successUrl` required. `reference` → `client_reference_id` + `metadata.reference` (also on the PaymentIntent). Extra params via `providerOptions` (e.g. `{ payment_method_types: ['card', 'oxxo'] }`).
- **getPayment**: accepts `cs_…` or `pi_…`.
- **findByReference**: Search API `metadata['reference']:'…'` (eventually consistent, may lag ~1 minute).
- **Webhooks**: `Stripe-Signature` `t=…,v1=…` verified as `HMAC-SHA256("{t}.{rawBody}")`, multiple `v1` supported, 300 s tolerance.

| Stripe event                                                                          | Normalized                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| checkout.session.completed (paid) / async_payment_succeeded, payment_intent.succeeded | payment.succeeded                             |
| checkout.session.completed (unpaid), payment_intent.processing / requires_action      | payment.pending                               |
| checkout.session.async_payment_failed, payment_intent.payment_failed                  | payment.failed                                |
| checkout.session.expired                                                              | payment.expired                               |
| payment_intent.canceled                                                               | payment.canceled                              |
| payment_intent.amount_capturable_updated                                              | payment.authorized                            |
| charge.refunded                                                                       | payment.refunded / payment.partially_refunded |

## PayPal

```ts
paypal: {
  clientId: '…',
  clientSecret: '…',
  webhookId: '…',             // required to verify webhooks
  environment: 'production',  // default: sandbox
  brandName: 'My Shop',
  autoCaptureOnApproval: true,
}
```

- **Checkout**: Orders v2 with `intent: CAPTURE`; `url` is the `payer-action` link. `reference` → `purchase_units[0].custom_id` and `reference_id`.
- **Currencies**: PayPal's supported list only; HUF, JPY and TWD must be whole amounts.
- **Capture**: automatic on `CHECKOUT.ORDER.APPROVED` through `PaymentsService.handleWebhook`, or manual with `payments.capture('paypal', orderId)`. Idempotent (`PayPal-Request-Id`), and `ORDER_ALREADY_CAPTURED` resolves to the current order.
- **Webhooks**: verified locally (no extra API call): the certificate from `paypal-cert-url` is downloaded only from `https://api(-m)(.sandbox).paypal.com/v1/notifications/certs/…`, cached, checked for expiry, and the signature verified with RSA-SHA256 over `transmissionId|transmissionTime|webhookId|crc32(rawBody)`.
- **findByReference**: not available in PayPal's API — store the order id.

| PayPal event                                        | Normalized                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| CHECKOUT.ORDER.APPROVED                             | payment.authorized                                                |
| PAYMENT.CAPTURE.COMPLETED, CHECKOUT.ORDER.COMPLETED | payment.succeeded                                                 |
| PAYMENT.CAPTURE.PENDING                             | payment.pending                                                   |
| PAYMENT.CAPTURE.DENIED / DECLINED                   | payment.failed                                                    |
| PAYMENT.CAPTURE.REFUNDED / REVERSED                 | payment.refunded (use `getPayment` for the exact refunded amount) |
