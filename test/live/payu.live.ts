import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { PayUProvider } from '../../src/providers/payu/payu.provider.js';

/**
 * Runs against PayU's real sandbox with the public test credentials from their docs.
 * `npm run test:live` — skipped in the regular suite.
 */
const payu = new PayUProvider({
  apiKey: '4Vj8eK4rloUd272L48hsrarnUA',
  apiLogin: 'pRRXKOl8ikMmt9u',
  merchantId: '508029',
  accountId: '512321',
  environment: 'sandbox',
});

describe('PayU sandbox (live)', () => {
  it('accepts ORDER_DETAIL_BY_REFERENCE_CODE and returns null for an unknown reference', async () => {
    await expect(payu.findByReference(`nestjs-latam-payments-${Date.now()}`)).resolves.toBeNull();
  }, 30_000);

  it('accepts ORDER_DETAIL and reports unknown orders as a ProviderError', async () => {
    const error = await payu.getPayment('1').catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
  }, 30_000);

  // Smoke test only: the sandbox answers the same page for valid and invalid signatures,
  // so signature correctness is covered by the official vectors in test/providers/payu.spec.ts.
  it('serves the WebCheckout endpoint the form posts to', async () => {
    const session = await payu.createCheckout({ amount: 2_000_000, currency: 'COP', reference: `live-${Date.now()}` });
    const response = await fetch(session.form!.action, {
      method: 'POST',
      body: new URLSearchParams(session.form!.fields),
      redirect: 'manual',
    });
    expect(response.status).toBeLessThan(500);
  }, 30_000);
});
