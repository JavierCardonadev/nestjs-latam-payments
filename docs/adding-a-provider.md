# Adding a provider

Every gateway is a class implementing `PaymentProvider`. You can ship one inside your app (`customProviders`) or contribute it to this repo.

## 1. Implement the interface

```ts
import {
  HttpClient,
  PaymentValidationError,
  UnsupportedOperationError,
  WebhookVerificationError,
  hmacSha256Hex,
  safeEqual,
  toDecimalString,
  type CheckoutRequest,
  type CheckoutSession,
  type Payment,
  type PaymentEvent,
  type PaymentProvider,
  type Refund,
  type RefundRequest,
  type WebhookRequest,
} from 'nestjs-latam-payments';

export class AcmePayProvider implements PaymentProvider {
  readonly name = 'acmepay';
  readonly capabilities = {
    checkout: true,
    getPayment: true,
    findByReference: false,
    refund: true,
    partialRefund: false,
    capture: false,
    webhooks: true,
  };
  private readonly http: HttpClient;

  constructor(private readonly config: { apiKey: string; webhookSecret: string }) {
    this.http = new HttpClient(this.name);
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    /* … */
  }
  async getPayment(id: string): Promise<Payment> {
    /* … */
  }
  async findByReference(): Promise<Payment | null> {
    throw new UnsupportedOperationError(this.name, 'findByReference');
  }
  async refund(request: RefundRequest): Promise<Refund> {
    /* … */
  }
  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    /* … */
  }
}
```

```ts
PaymentsModule.forRoot({ customProviders: [new AcmePayProvider({ apiKey, webhookSecret })] });
```

Its webhook is served at `POST /payments/webhooks/acmepay` automatically.

## 2. Rules

- **Amounts** are integer minor units in and out. Use `toDecimalString` / `toMinorUnits` when the API uses decimals; never do float math.
- **Statuses**: map every native status explicitly; unknown values fall back to `pending`, never `succeeded`.
- **Webhooks**
  - Verify over `request.rawBody` (bytes), before parsing JSON.
  - Compare signatures with `safeEqual` (constant time).
  - Throw `WebhookVerificationError` for anything unverifiable (missing header, bad signature, stale timestamp).
  - If the provider doesn't sign the status, fetch the payment from its API instead of trusting the body.
  - `event.id` must be stable across retries — handlers deduplicate with it.
- **HTTP**: use `HttpClient`, which throws `ProviderError` with `httpStatus`, `code` and `raw`.
- **No SDK dependencies**. Native `fetch` and `node:crypto` only.
- **Unsupported operations** throw `UnsupportedOperationError` and are `false` in `capabilities`.

## 3. Contributing it upstream

1. `src/providers/<name>/<name>.provider.ts` + export from `src/index.ts`.
2. Add the config to `BuiltInProvidersConfig` and `createProviderRegistry`.
3. Tests in `test/providers/<name>.spec.ts` using `test/helpers/mock-fetch.ts`:
   - signature helpers checked against **official test vectors** from the provider's docs (link the source in a comment);
   - webhook accepted with a valid signature, rejected when tampered, missing, or stale;
   - status mapping table;
   - request bodies for checkout, get and refund.
4. Document it in `docs/providers.md` and the table in both READMEs.

Open a [provider request](https://github.com/JavierCardonadev/nestjs-latam-payments/issues/new?template=provider-request.yml) first if you want feedback on the approach.
