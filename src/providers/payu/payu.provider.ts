import { hashHex, safeEqual, type HashAlgorithm } from '../../core/crypto.js';
import { PaymentValidationError, ProviderError, WebhookVerificationError } from '../../core/errors.js';
import { HttpClient, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency, toDecimalString, toMinorUnits } from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  PaymentStatus,
  ProviderCapabilities,
  ProviderEnvironment,
  Refund,
  RefundRequest,
  WebhookRequest,
} from '../../core/types.js';
import { dateFromIso, eventTypeForStatus, parseFormWebhook, requireConfig, requireNonEmpty } from '../../core/utils.js';

export interface PayUConfig {
  apiKey: string;
  apiLogin: string;
  merchantId: string;
  /** Account per country (determines available payment methods). */
  accountId: string;
  environment?: ProviderEnvironment;
  /** Signature algorithm for the WebCheckout form. Default: sha256. */
  signatureAlgorithm?: HashAlgorithm;
  language?: 'es' | 'en' | 'pt';
  http?: HttpClientOptions;
}

const URLS: Record<ProviderEnvironment, { checkout: string; payments: string; reports: string }> = {
  sandbox: {
    checkout: 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/',
    payments: 'https://sandbox.api.payulatam.com/payments-api/4.0/service.cgi',
    reports: 'https://sandbox.api.payulatam.com/reports-api/4.0/service.cgi',
  },
  production: {
    checkout: 'https://checkout.payulatam.com/ppp-web-gateway-payu/',
    payments: 'https://api.payulatam.com/payments-api/4.0/service.cgi',
    reports: 'https://api.payulatam.com/reports-api/4.0/service.cgi',
  },
};

const ALGORITHM_FIELD: Record<HashAlgorithm, string> = { md5: 'MD5', sha1: 'SHA', sha256: 'SHA256' };

/** `state_pol` values sent to the confirmation page. */
const STATE_POL: Record<string, PaymentStatus> = {
  '4': 'succeeded',
  '5': 'expired',
  '6': 'failed',
  '7': 'pending',
  '104': 'failed',
};

const ORDER_STATUS: Record<string, PaymentStatus> = {
  NEW: 'pending',
  IN_PROGRESS: 'pending',
  AUTHORIZED: 'authorized',
  CAPTURED: 'succeeded',
  CANCELLED: 'canceled',
  DECLINED: 'failed',
  REFUNDED: 'refunded',
};

const TX_STATE: Record<string, PaymentStatus> = {
  APPROVED: 'succeeded',
  DECLINED: 'failed',
  ERROR: 'failed',
  EXPIRED: 'expired',
  PENDING: 'pending',
};

/** PayU LATAM (CO, MX, PE, AR, BR, CL, PA): WebCheckout + confirmation page. */
export class PayUProvider implements PaymentProvider {
  readonly name = 'payu';
  readonly capabilities: ProviderCapabilities = {
    checkout: true,
    getPayment: true,
    findByReference: true,
    refund: true,
    partialRefund: true,
    capture: false,
    webhooks: true,
  };

  readonly environment: ProviderEnvironment;
  private readonly http: HttpClient;
  private readonly urls: (typeof URLS)[ProviderEnvironment];

  constructor(private readonly config: PayUConfig) {
    requireConfig(this.name, config, ['apiKey', 'apiLogin', 'merchantId', 'accountId']);
    this.environment = config.environment ?? 'sandbox';
    this.urls = URLS[this.environment];
    this.http = new HttpClient(this.name, config.http);
  }

  /** PayU amounts: "20000" when there are no cents, "20000.50" otherwise. */
  static formatAmount(amountMinor: number, currency: string): string {
    const decimal = toDecimalString(amountMinor, currency);
    return decimal.includes('.') && /\.0+$/.test(decimal) ? decimal.replace(/\.0+$/, '') : decimal;
  }

  /** `apiKey~merchantId~referenceCode~amount~currency[~paymentMethods~iin~pseBanks]` (PayU payment form docs). */
  formSignature(
    referenceCode: string,
    amount: string,
    currency: string,
    extras: { paymentMethods?: string; iin?: string; pseBanks?: string } = {},
    algorithm: HashAlgorithm = this.config.signatureAlgorithm ?? 'sha256',
  ): string {
    const parts = [this.config.apiKey, this.config.merchantId, referenceCode, amount, currency];
    if (extras.paymentMethods || extras.iin || extras.pseBanks) {
      parts.push(extras.paymentMethods ?? '', extras.iin ?? '', extras.pseBanks ?? '');
    }
    return hashHex(algorithm, parts.join('~'));
  }

  /**
   * Confirmation signature: `apiKey~merchant_id~reference_sale~new_value~currency~state_pol`,
   * where `new_value` keeps one decimal when the second one is zero (150.00 -> 150.0, 150.26 -> 150.26).
   */
  confirmationSignature(
    fields: { merchant_id: string; reference_sale: string; value: string; currency: string; state_pol: string },
    algorithm: HashAlgorithm = 'md5',
  ): string {
    const twoDecimals = toDecimalString(toMinorUnits(fields.value, fields.currency, 2), fields.currency, 2);
    const newValue = twoDecimals.endsWith('0') ? twoDecimals.slice(0, -1) : twoDecimals;
    return hashHex(
      algorithm,
      [this.config.apiKey, fields.merchant_id, fields.reference_sale, newValue, fields.currency, fields.state_pol].join(
        '~',
      ),
    );
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    assertMinorUnits(request.amount);
    const currency = normalizeCurrency(request.currency);
    const amount = PayUProvider.formatAmount(request.amount, currency);
    const algorithm = this.config.signatureAlgorithm ?? 'sha256';
    const options = { ...request.providerOptions } as Record<string, unknown>;

    const extras = {
      paymentMethods: options.paymentMethods as string | undefined,
      iin: options.iin as string | undefined,
      pseBanks: options.pseBanks as string | undefined,
    };

    const fields: Record<string, string> = {
      merchantId: this.config.merchantId,
      accountId: this.config.accountId,
      description: (request.description ?? `Order ${reference}`).slice(0, 255),
      referenceCode: reference,
      amount,
      tax: '0',
      taxReturnBase: '0',
      currency,
      signature: this.formSignature(reference, amount, currency, extras, algorithm),
      algorithmSignature: ALGORITHM_FIELD[algorithm],
      test: this.environment === 'sandbox' ? '1' : '0',
    };
    const customer = request.customer;
    if (customer?.email) fields.buyerEmail = customer.email;
    if (customer?.name) fields.buyerFullName = customer.name;
    if (customer?.phone) fields.telephone = customer.phone;
    if (request.successUrl) fields.responseUrl = request.successUrl;
    if (request.notificationUrl) fields.confirmationUrl = request.notificationUrl;
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null) fields[key] = String(value);
    }

    return {
      provider: this.name,
      id: reference,
      reference,
      form: { method: 'POST', action: this.urls.checkout, fields },
      raw: { fields },
    };
  }

  private async call<T>(url: string, command: string, extra: Record<string, unknown>): Promise<T> {
    const { data } = await this.http.request<
      { code?: string; error?: string | null; result?: any } & Record<string, any>
    >({
      method: 'POST',
      url,
      json: {
        test: this.environment === 'sandbox',
        language: this.config.language ?? 'es',
        command,
        merchant: { apiLogin: this.config.apiLogin, apiKey: this.config.apiKey },
        ...extra,
      },
    });
    // PayU reports business errors with HTTP 200 and code "ERROR".
    if (data.code !== 'SUCCESS') {
      throw new ProviderError(this.name, data.error ?? `${command} failed`, { code: data.code, raw: data });
    }
    return data as T;
  }

  async getPayment(orderId: string): Promise<Payment> {
    const id = requireNonEmpty(orderId, 'paymentId');
    const data = await this.call<{ result?: { payload?: any } }>(this.urls.reports, 'ORDER_DETAIL', {
      details: { orderId: Number(id) },
    });
    const order = data.result?.payload;
    if (!order) throw new ProviderError(this.name, `order ${id} not found`, { httpStatus: 404, raw: data });
    return this.fromOrder(order);
  }

  async findByReference(reference: string): Promise<Payment | null> {
    const data = await this.call<{ result?: { payload?: any[] | null } }>(
      this.urls.reports,
      'ORDER_DETAIL_BY_REFERENCE_CODE',
      {
        details: { referenceCode: requireNonEmpty(reference, 'reference') },
      },
    );
    const orders = data.result?.payload ?? [];
    if (!orders.length) return null;
    const latest = [...orders].sort((a, b) => Number(b.id) - Number(a.id))[0];
    return this.fromOrder(latest);
  }

  async refund(request: RefundRequest): Promise<Refund> {
    const orderId = requireNonEmpty(request.paymentId, 'paymentId');
    const payment = await this.getPayment(orderId);
    const transactions: any[] = (payment.raw as any)?.transactions ?? [];
    const parent = transactions.find(
      (t) => ['AUTHORIZATION_AND_CAPTURE', 'CAPTURE'].includes(t.type) && t.transactionResponse?.state === 'APPROVED',
    );
    if (!parent) throw new PaymentValidationError(`payu: order ${orderId} has no approved transaction to refund`);

    const transaction: Record<string, unknown> = {
      order: { id: Number(orderId) },
      type: request.amount === undefined ? 'REFUND' : 'PARTIAL_REFUND',
      parentTransactionId: parent.id,
      reason: request.reason ?? 'Refund requested by merchant',
    };
    if (request.amount !== undefined) {
      assertMinorUnits(request.amount);
      const currency = payment.currency ?? 'COP';
      transaction.additionalValues = {
        TX_VALUE: { value: Number(toDecimalString(request.amount, currency)), currency },
      };
    }

    const data = await this.call<{ transactionResponse?: Record<string, any> }>(
      this.urls.payments,
      'SUBMIT_TRANSACTION',
      {
        transaction,
      },
    );
    const response = data.transactionResponse ?? {};
    return {
      provider: this.name,
      id: String(response.transactionId ?? ''),
      paymentId: orderId,
      // PayU reviews most refunds manually: PENDING is the normal answer.
      status: response.state === 'APPROVED' ? 'succeeded' : response.state === 'PENDING' ? 'pending' : 'failed',
      amount: request.amount ?? payment.amount,
      currency: payment.currency,
      raw: data,
    };
  }

  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    const fields = parseFormWebhook(this.name, request);
    const { merchant_id, reference_sale, value, currency, state_pol, sign } = fields;
    if (!merchant_id || !reference_sale || !value || !currency || !state_pol || !sign) {
      throw new WebhookVerificationError(this.name, 'missing confirmation fields');
    }
    if (merchant_id !== String(this.config.merchantId)) {
      throw new WebhookVerificationError(this.name, 'merchant_id does not match configuration');
    }

    const algorithm: HashAlgorithm | undefined = { 32: 'md5', 40: 'sha1', 64: 'sha256' }[sign.length] as
      HashAlgorithm | undefined;
    let expected: string;
    try {
      expected = algorithm
        ? this.confirmationSignature({ merchant_id, reference_sale, value, currency, state_pol }, algorithm)
        : '';
    } catch {
      throw new WebhookVerificationError(this.name, 'invalid amount');
    }
    if (!algorithm || !safeEqual(expected, sign)) {
      throw new WebhookVerificationError(this.name, 'sign mismatch');
    }

    const status = STATE_POL[state_pol] ?? 'pending';
    return {
      provider: this.name,
      id: fields.transaction_id || `${fields.reference_pol}:${state_pol}`,
      type: eventTypeForStatus(status),
      providerType: `confirmation.state_pol.${state_pol}`,
      paymentId: fields.reference_pol || undefined,
      reference: reference_sale,
      status,
      amount: toMinorUnits(value, currency),
      currency,
      occurredAt: dateFromIso(fields.transaction_date?.replace(' ', 'T')),
      raw: fields,
    };
  }

  private fromOrder(order: Record<string, any>): Payment {
    const transactions: any[] = order.transactions ?? [];
    const latest = transactions[transactions.length - 1];
    const txValue = order.additionalValues?.TX_VALUE ?? latest?.additionalValues?.TX_VALUE;
    const currency: string | undefined = txValue?.currency;
    const status = ORDER_STATUS[order.status] ?? TX_STATE[latest?.transactionResponse?.state] ?? 'pending';
    return {
      provider: this.name,
      id: String(order.id),
      reference: order.referenceCode,
      status,
      amount: txValue?.value !== undefined && currency ? toMinorUnits(String(txValue.value), currency) : undefined,
      currency,
      method: latest?.paymentMethod,
      createdAt: latest?.transactionResponse?.operationDate
        ? new Date(Number(latest.transactionResponse.operationDate))
        : undefined,
      raw: order,
    };
  }
}
