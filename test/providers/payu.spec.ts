import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentValidationError, ProviderError, WebhookVerificationError } from '../../src/core/errors.js';
import { PayUProvider, type PayUConfig } from '../../src/providers/payu/payu.provider.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

// Public sandbox credentials published in PayU's documentation.
const docsConfig: PayUConfig = {
  apiKey: '4Vj8eK4rloUd272L48hsrarnUA',
  apiLogin: 'pRRXKOl8ikMmt9u',
  merchantId: '508029',
  accountId: '512321',
};

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const REPORTS = 'https://sandbox.api.payulatam.com/reports-api/4.0/service.cgi';
const PAYMENTS = 'https://sandbox.api.payulatam.com/payments-api/4.0/service.cgi';

function provider(routes: MockRoute[] = [], config: Partial<PayUConfig> = {}) {
  const mock = mockFetch(routes);
  return { payu: new PayUProvider({ ...docsConfig, ...config, http: { fetch: mock.fetch } }), calls: mock.calls };
}

const order = {
  id: 844427581,
  accountId: 512321,
  status: 'CAPTURED',
  referenceCode: 'ORDER-7',
  additionalValues: { TX_VALUE: { value: 20000, currency: 'COP' } },
  transactions: [
    {
      id: '5fde3c2c-540d-4579-96f7-2a4b8c65a951',
      type: 'AUTHORIZATION_AND_CAPTURE',
      paymentMethod: 'MASTERCARD',
      transactionResponse: { state: 'APPROVED', operationDate: 1620064792953 },
    },
  ],
};

describe('PayUProvider', () => {
  describe('payment form signature (official examples)', () => {
    const { payu } = provider();
    it.each([
      ['md5', '7ee7cf808ce6a39b17481c54f2c57acc'],
      ['sha1', 'fa890d3f94e12b5cdb62e8771453b99b78e7ccdc'],
      ['sha256', 'af3899a22336b79db46006491d15813158826f944599bf3bf601e2327f898022'],
    ] as const)('%s', (algorithm, expected) => {
      expect(payu.formSignature('TestPayU', '20000', 'COP', {}, algorithm)).toBe(expected);
    });

    it('appends paymentMethods, iin and pseBanks when present', () => {
      expect(payu.formSignature('TestPayU', '20000', 'COP', { paymentMethods: 'VISA,PSE' }, 'md5')).toBe(
        md5('4Vj8eK4rloUd272L48hsrarnUA~508029~TestPayU~20000~COP~VISA,PSE~~'),
      );
    });
  });

  it('formats amounts the way PayU signs them', () => {
    expect(PayUProvider.formatAmount(2_000_000, 'COP')).toBe('20000');
    expect(PayUProvider.formatAmount(2_000_050, 'COP')).toBe('20000.50');
    expect(PayUProvider.formatAmount(15000, 'CLP')).toBe('15000');
  });

  it('builds a signed WebCheckout POST form', async () => {
    const { payu } = provider();
    const session = await payu.createCheckout({
      amount: 2_000_000,
      currency: 'COP',
      reference: 'TestPayU',
      description: 'Test order',
      successUrl: 'https://shop.test/return',
      notificationUrl: 'https://shop.test/payments/webhooks/payu',
      customer: { email: 'test@test.com' },
    });
    expect(session.url).toBeUndefined();
    expect(session.form).toMatchObject({
      method: 'POST',
      action: 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/',
      fields: {
        merchantId: '508029',
        accountId: '512321',
        referenceCode: 'TestPayU',
        amount: '20000',
        currency: 'COP',
        algorithmSignature: 'SHA256',
        signature: 'af3899a22336b79db46006491d15813158826f944599bf3bf601e2327f898022',
        test: '1',
        buyerEmail: 'test@test.com',
        responseUrl: 'https://shop.test/return',
        confirmationUrl: 'https://shop.test/payments/webhooks/payu',
      },
    });
  });

  describe('confirmation signature', () => {
    const { payu } = provider();
    const fields = { merchant_id: '508029', reference_sale: 'ORDER-7', currency: 'COP', state_pol: '4' };

    it('drops the trailing zero when the second decimal is 0 (150.00 -> 150.0)', () => {
      expect(payu.confirmationSignature({ ...fields, value: '150.00' })).toBe(
        md5('4Vj8eK4rloUd272L48hsrarnUA~508029~ORDER-7~150.0~COP~4'),
      );
    });

    it('keeps two decimals otherwise (150.26)', () => {
      expect(payu.confirmationSignature({ ...fields, value: '150.26' })).toBe(
        md5('4Vj8eK4rloUd272L48hsrarnUA~508029~ORDER-7~150.26~COP~4'),
      );
    });
  });

  describe('webhooks (confirmation page)', () => {
    const confirmation = (overrides: Record<string, string> = {}) => {
      const fields: Record<string, string> = {
        merchant_id: '508029',
        reference_sale: 'ORDER-7',
        reference_pol: '844427581',
        transaction_id: '5fde3c2c-540d-4579-96f7-2a4b8c65a951',
        value: '20000.00',
        currency: 'COP',
        state_pol: '4',
        transaction_date: '2026-09-13 10:00:00',
        ...overrides,
      };
      fields.sign ??= md5(`4Vj8eK4rloUd272L48hsrarnUA~508029~${fields.reference_sale}~20000.0~COP~${fields.state_pol}`);
      return { headers: {}, rawBody: new URLSearchParams(fields).toString() };
    };

    it('verifies the sign and normalizes the event', async () => {
      const event = await provider().payu.parseWebhook(confirmation());
      expect(event).toMatchObject({
        type: 'payment.succeeded',
        paymentId: '844427581',
        reference: 'ORDER-7',
        amount: 2_000_000,
        currency: 'COP',
        id: '5fde3c2c-540d-4579-96f7-2a4b8c65a951',
      });
    });

    it('accepts an already-parsed body', async () => {
      const raw = Object.fromEntries(new URLSearchParams(confirmation().rawBody));
      await expect(provider().payu.parseWebhook({ headers: {}, rawBody: '', body: raw })).resolves.toMatchObject({
        type: 'payment.succeeded',
      });
    });

    it.each([
      ['5', 'payment.expired'],
      ['6', 'payment.failed'],
      ['7', 'payment.pending'],
    ])('maps state_pol %s to %s', async (state, type) => {
      const body = confirmation({
        state_pol: state,
        sign: md5(`4Vj8eK4rloUd272L48hsrarnUA~508029~ORDER-7~20000.0~COP~${state}`),
      });
      expect((await provider().payu.parseWebhook(body)).type).toBe(type);
    });

    it('rejects a forged approval', async () => {
      const forged = confirmation({
        state_pol: '4',
        sign: md5('4Vj8eK4rloUd272L48hsrarnUA~508029~ORDER-7~20000.0~COP~6'),
      });
      await expect(provider().payu.parseWebhook(forged)).rejects.toThrow(WebhookVerificationError);
    });

    it('rejects confirmations for another merchant', async () => {
      await expect(provider().payu.parseWebhook(confirmation({ merchant_id: '999' }))).rejects.toThrow(/merchant_id/);
    });
  });

  it('reads orders from the reports API', async () => {
    const { payu, calls } = provider([{ url: REPORTS, body: { code: 'SUCCESS', result: { payload: order } } }]);
    const payment = await payu.getPayment('844427581');
    expect(calls[0]!.json()).toMatchObject({ command: 'ORDER_DETAIL', details: { orderId: 844427581 }, test: true });
    expect(payment).toMatchObject({
      id: '844427581',
      status: 'succeeded',
      amount: 2_000_000,
      currency: 'COP',
      method: 'MASTERCARD',
    });
  });

  it('finds the latest order by reference', async () => {
    const older = { ...order, id: 1, status: 'DECLINED' };
    const { payu } = provider([{ url: REPORTS, body: { code: 'SUCCESS', result: { payload: [older, order] } } }]);
    expect(await payu.findByReference('ORDER-7')).toMatchObject({ id: '844427581', status: 'succeeded' });
  });

  it('returns null when no order has the reference', async () => {
    const { payu } = provider([{ url: REPORTS, body: { code: 'SUCCESS', result: { payload: null } } }]);
    expect(await payu.findByReference('nope')).toBeNull();
  });

  it('turns code=ERROR (HTTP 200) into ProviderError', async () => {
    const { payu } = provider([{ url: REPORTS, body: { code: 'ERROR', error: 'Invalid credentials' } }]);
    await expect(payu.getPayment('1')).rejects.toThrow(ProviderError);
  });

  it('submits partial refunds against the approved transaction', async () => {
    const { payu, calls } = provider([
      { url: REPORTS, body: { code: 'SUCCESS', result: { payload: order } } },
      { url: PAYMENTS, body: { code: 'SUCCESS', transactionResponse: { transactionId: 'rf-1', state: 'PENDING' } } },
    ]);
    const refund = await payu.refund({ paymentId: '844427581', amount: 500_000, reason: 'Damaged item' });
    expect(refund).toMatchObject({ id: 'rf-1', status: 'pending', amount: 500_000 });
    expect(calls[1]!.json()).toMatchObject({
      command: 'SUBMIT_TRANSACTION',
      transaction: {
        order: { id: 844427581 },
        type: 'PARTIAL_REFUND',
        parentTransactionId: '5fde3c2c-540d-4579-96f7-2a4b8c65a951',
        reason: 'Damaged item',
        additionalValues: { TX_VALUE: { value: 5000, currency: 'COP' } },
      },
    });
  });

  it('refuses to refund an order without an approved transaction', async () => {
    const pending = {
      ...order,
      status: 'IN_PROGRESS',
      transactions: [{ ...order.transactions[0], transactionResponse: { state: 'PENDING' } }],
    };
    const { payu } = provider([{ url: REPORTS, body: { code: 'SUCCESS', result: { payload: pending } } }]);
    await expect(payu.refund({ paymentId: '844427581' })).rejects.toThrow(PaymentValidationError);
  });
});
