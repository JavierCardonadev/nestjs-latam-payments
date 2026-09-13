import { hashHex, safeEqual } from '../../core/crypto.js';
import {
  PaymentsConfigurationError,
  PaymentValidationError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../core/errors.js';
import { getHeader, HttpClient, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency } from '../../core/money.js';
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
import {
  dateFromIso,
  dateFromUnixSeconds,
  eventTypeForStatus,
  getPath,
  parseJsonWebhook,
  requireConfig,
  requireNonEmpty,
} from '../../core/utils.js';

export interface WompiConfig {
  /** pub_test_... / pub_prod_... */
  publicKey: string;
  /** prv_test_... / prv_prod_... Required to query and void transactions. */
  privateKey: string;
  /** test_integrity_... / prod_integrity_... Signs checkout links. */
  integritySecret: string;
  /** test_events_... / prod_events_... Verifies webhooks. */
  eventsSecret: string;
  /** Inferred from the key prefixes when omitted. */
  environment?: ProviderEnvironment;
  /** Reject events whose `timestamp` is older than this many seconds. Off by default (Wompi retries). */
  webhookToleranceSeconds?: number;
  checkoutUrl?: string;
  http?: HttpClientOptions;
}

const API_URL: Record<ProviderEnvironment, string> = {
  sandbox: 'https://sandbox.wompi.co/v1',
  production: 'https://production.wompi.co/v1',
};

const STATUS: Record<string, PaymentStatus> = {
  PENDING: 'pending',
  APPROVED: 'succeeded',
  DECLINED: 'failed',
  VOIDED: 'canceled',
  ERROR: 'failed',
};

/**
 * Wompi (Colombia): cards, Nequi, PSE, Bancolombia transfer/QR, Daviplata.
 * Checkout uses the hosted Web Checkout with an integrity signature.
 */
export class WompiProvider implements PaymentProvider {
  readonly name = 'wompi';
  readonly capabilities: ProviderCapabilities = {
    checkout: true,
    getPayment: true,
    findByReference: false,
    refund: true,
    partialRefund: false,
    capture: false,
    webhooks: true,
  };

  private readonly http: HttpClient;
  private readonly apiUrl: string;
  readonly environment: ProviderEnvironment;

  constructor(private readonly config: WompiConfig) {
    requireConfig(this.name, config, ['publicKey', 'privateKey', 'integritySecret', 'eventsSecret']);
    this.environment = config.environment ?? (config.publicKey.startsWith('pub_prod_') ? 'production' : 'sandbox');
    const keyIsProd = config.publicKey.startsWith('pub_prod_');
    if (keyIsProd !== (this.environment === 'production')) {
      throw new PaymentsConfigurationError(
        `wompi: environment "${this.environment}" does not match public key prefix "${config.publicKey.slice(0, 9)}"`,
      );
    }
    this.apiUrl = API_URL[this.environment];
    this.http = new HttpClient(this.name, config.http);
  }

  /**
   * SHA-256 of `reference + amountInCents + currency [+ expirationTime] + integritySecret`
   * (https://docs.wompi.co/docs/colombia/widget-checkout-web/).
   */
  integritySignature(reference: string, amountInCents: number, currency: string, expirationTime?: string): string {
    return hashHex(
      'sha256',
      `${reference}${amountInCents}${currency}${expirationTime ?? ''}${this.config.integritySecret}`,
    );
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    assertMinorUnits(request.amount);
    const currency = normalizeCurrency(request.currency);
    if (currency !== 'COP') {
      throw new PaymentValidationError(`wompi only processes COP; received ${currency}`);
    }

    const expirationTime = request.expiresAt?.toISOString();
    const fields: Record<string, string> = {
      'public-key': this.config.publicKey,
      currency,
      'amount-in-cents': String(request.amount),
      reference,
      'signature:integrity': this.integritySignature(reference, request.amount, currency, expirationTime),
    };
    if (request.successUrl) fields['redirect-url'] = request.successUrl;
    if (expirationTime) fields['expiration-time'] = expirationTime;

    const customer = request.customer;
    if (customer?.email) fields['customer-data:email'] = customer.email;
    if (customer?.name) fields['customer-data:full-name'] = customer.name;
    if (customer?.phone) {
      const match = /^\+(\d{1,3})\s*(.+)$/.exec(customer.phone.trim());
      fields['customer-data:phone-number'] = (match?.[2] ?? customer.phone).replace(/\D/g, '');
      fields['customer-data:phone-number-prefix'] = match ? `+${match[1]}` : '+57';
    }
    if (customer?.documentNumber && customer.documentType) {
      fields['customer-data:legal-id'] = customer.documentNumber;
      fields['customer-data:legal-id-type'] = customer.documentType;
    }
    for (const [key, value] of Object.entries(request.providerOptions ?? {})) {
      if (value !== undefined && value !== null) fields[key] = String(value);
    }

    const action = this.config.checkoutUrl ?? 'https://checkout.wompi.co/p/';
    const url = `${action}?${new URLSearchParams(fields).toString()}`;

    return {
      provider: this.name,
      // Web Checkout creates the transaction only when the buyer pays; your reference is the handle.
      id: reference,
      reference,
      url,
      form: { method: 'GET', action, fields },
      expiresAt: request.expiresAt,
      raw: { fields },
    };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    const { data } = await this.http.request<{ data: WompiTransaction }>({
      method: 'GET',
      url: `${this.apiUrl}/transactions/${encodeURIComponent(requireNonEmpty(paymentId, 'paymentId'))}`,
      headers: { Authorization: `Bearer ${this.config.privateKey}` },
    });
    return this.toPayment(data.data);
  }

  async findByReference(): Promise<Payment | null> {
    throw new UnsupportedOperationError(
      this.name,
      'findByReference',
      'store the transaction id from the transaction.updated webhook instead',
    );
  }

  /** Voids an approved card transaction (full amount only). */
  async refund(request: RefundRequest): Promise<Refund> {
    const paymentId = requireNonEmpty(request.paymentId, 'paymentId');
    if (request.amount !== undefined) {
      const payment = await this.getPayment(paymentId);
      if (payment.amount !== undefined && request.amount !== payment.amount) {
        throw new UnsupportedOperationError(this.name, 'partial refunds', 'Wompi voids the full card transaction');
      }
    }
    const { data } = await this.http.request<{ data?: Record<string, any> }>({
      method: 'POST',
      url: `${this.apiUrl}/transactions/${encodeURIComponent(paymentId)}/void`,
      headers: { Authorization: `Bearer ${this.config.privateKey}` },
      json: {},
    });
    const body = data?.data ?? {};
    const transaction = body.transaction ?? body;
    const status = String(transaction.status ?? body.status ?? '').toUpperCase();
    return {
      provider: this.name,
      id: String(body.id ?? transaction.id ?? paymentId),
      paymentId,
      status: status === 'VOIDED' ? 'succeeded' : status === 'DECLINED' || status === 'ERROR' ? 'failed' : 'pending',
      amount: typeof transaction.amount_in_cents === 'number' ? transaction.amount_in_cents : undefined,
      currency: transaction.currency,
      raw: data,
    };
  }

  /** Verifies `signature.checksum` (or `X-Event-Checksum`) as documented in docs.wompi.co/docs/colombia/eventos. */
  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    const event = parseJsonWebhook(this.name, request);
    const properties: unknown = event?.signature?.properties;
    const checksum: string | undefined = getHeader(request.headers, 'x-event-checksum') ?? event?.signature?.checksum;

    if (!Array.isArray(properties) || !checksum || event.timestamp === undefined || !event.data) {
      throw new WebhookVerificationError(this.name, 'missing signature, timestamp or data');
    }

    const concatenated = properties.map((path) => {
      const value = getPath(event.data, String(path));
      return value === undefined || value === null ? '' : String(value);
    });
    const expected = hashHex('sha256', `${concatenated.join('')}${event.timestamp}${this.config.eventsSecret}`);
    if (!safeEqual(expected, checksum)) {
      throw new WebhookVerificationError(this.name, 'checksum mismatch');
    }

    const tolerance = this.config.webhookToleranceSeconds;
    if (tolerance !== undefined && Math.abs(Date.now() / 1000 - Number(event.timestamp)) > tolerance) {
      throw new WebhookVerificationError(this.name, 'timestamp outside tolerance');
    }

    const transaction: WompiTransaction | undefined = event.data.transaction;
    const eventName = String(event.event ?? '');
    const payment = eventName === 'transaction.updated' && transaction ? this.toPayment(transaction) : undefined;

    return {
      provider: this.name,
      id: `${transaction?.id ?? eventName}:${transaction?.status ?? ''}:${event.timestamp}`,
      type: eventTypeForStatus(payment?.status),
      providerType: eventName,
      paymentId: payment?.id,
      reference: payment?.reference,
      status: payment?.status,
      amount: payment?.amount,
      currency: payment?.currency,
      occurredAt: dateFromIso(event.sent_at) ?? dateFromUnixSeconds(event.timestamp),
      payment,
      raw: event,
    };
  }

  private toPayment(transaction: WompiTransaction): Payment {
    return {
      provider: this.name,
      id: String(transaction.id),
      reference: transaction.reference,
      status: STATUS[String(transaction.status).toUpperCase()] ?? 'pending',
      amount: transaction.amount_in_cents,
      currency: transaction.currency,
      method: transaction.payment_method_type,
      createdAt: dateFromIso(transaction.created_at),
      raw: transaction,
    };
  }
}

export interface WompiTransaction {
  id: string;
  created_at?: string;
  amount_in_cents: number;
  reference: string;
  currency: string;
  payment_method_type?: string;
  status: string;
  status_message?: string | null;
  [key: string]: unknown;
}
