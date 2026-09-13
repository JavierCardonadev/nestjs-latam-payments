import { createVerify, X509Certificate } from 'node:crypto';
import { crc32 } from '../../core/crypto.js';
import {
  PaymentValidationError,
  ProviderError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../core/errors.js';
import { getHeader, HttpClient, rawBodyToString, type FetchLike, type HttpClientOptions } from '../../core/http.js';
import {
  assertMinorUnits,
  currencyDecimals,
  normalizeCurrency,
  toDecimalString,
  toMinorUnits,
} from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  PaymentEventType,
  PaymentStatus,
  ProviderCapabilities,
  ProviderEnvironment,
  Refund,
  RefundRequest,
  WebhookRequest,
} from '../../core/types.js';
import { dateFromIso, parseJsonWebhook, requireConfig, requireNonEmpty } from '../../core/utils.js';

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  /** Webhook id from the app's webhook settings. Required to verify webhooks. */
  webhookId?: string;
  environment?: ProviderEnvironment;
  brandName?: string;
  /** Capture automatically when `CHECKOUT.ORDER.APPROVED` arrives (PaymentsService). Default: true. */
  autoCaptureOnApproval?: boolean;
  baseUrl?: string;
  http?: HttpClientOptions;
  /** Override how signing certificates are downloaded (tests, egress proxies). */
  fetchCertificate?: (url: string) => Promise<string>;
}

/** Currencies PayPal accepts for REST payments. HUF, JPY and TWD can't carry decimals. */
export const PAYPAL_CURRENCIES = new Set([
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MYR',
  'MXN',
  'TWD',
  'NZD',
  'NOK',
  'PHP',
  'PLN',
  'GBP',
  'SGD',
  'SEK',
  'CHF',
  'THB',
  'USD',
]);
const PAYPAL_NO_DECIMALS = new Set(['HUF', 'JPY', 'TWD']);

const CERT_HOST = /^(api|api-m)(\.sandbox)?\.paypal\.com$/;

export class PayPalProvider implements PaymentProvider {
  readonly name = 'paypal';
  readonly capabilities: ProviderCapabilities = {
    checkout: true,
    getPayment: true,
    findByReference: false,
    refund: true,
    partialRefund: true,
    capture: true,
    webhooks: true,
  };

  readonly environment: ProviderEnvironment;
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private readonly certificates = new Map<string, Promise<string>>();

  constructor(private readonly config: PayPalConfig) {
    requireConfig(this.name, config, ['clientId', 'clientSecret']);
    this.environment = config.environment ?? 'sandbox';
    this.baseUrl =
      config.baseUrl ??
      (this.environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
    this.http = new HttpClient(this.name, config.http);
  }

  get autoCaptureOnApproval(): boolean {
    return this.config.autoCaptureOnApproval !== false;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.tokenRequest ??= (async () => {
      try {
        const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
        const { data } = await this.http.request<{ access_token: string; expires_in: number }>({
          method: 'POST',
          url: `${this.baseUrl}/v1/oauth2/token`,
          headers: { Authorization: `Basic ${credentials}` },
          form: new URLSearchParams({ grant_type: 'client_credentials' }),
        });
        this.token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
        return data.access_token;
      } finally {
        this.tokenRequest = undefined;
      }
    })();
    return this.tokenRequest;
  }

  private async authHeaders(requestId?: string) {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      'PayPal-Request-Id': requestId,
      Prefer: 'return=representation',
    };
  }

  private toValue(amountMinor: number, currency: string): string {
    if (!PAYPAL_CURRENCIES.has(currency)) {
      throw new PaymentValidationError(
        `paypal does not support ${currency}. Supported: ${[...PAYPAL_CURRENCIES].join(', ')}`,
      );
    }
    if (PAYPAL_NO_DECIMALS.has(currency)) {
      const factor = 10 ** currencyDecimals(currency);
      if (amountMinor % factor !== 0) {
        throw new PaymentValidationError(`paypal requires whole amounts for ${currency}`);
      }
      return String(amountMinor / factor);
    }
    return toDecimalString(amountMinor, currency);
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    assertMinorUnits(request.amount);
    const currency = normalizeCurrency(request.currency);
    if (reference.length > 127) throw new PaymentValidationError('paypal: reference must be at most 127 characters');

    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: reference,
          custom_id: reference,
          description: request.description?.slice(0, 127),
          amount: { currency_code: currency, value: this.toValue(request.amount, currency) },
        },
      ],
      payment_source: {
        paypal: {
          email_address: request.customer?.email,
          experience_context: {
            brand_name: this.config.brandName,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: request.successUrl,
            cancel_url: request.cancelUrl,
          },
        },
      },
      ...request.providerOptions,
    };

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v2/checkout/orders`,
      headers: await this.authHeaders(request.idempotencyKey),
      json: body,
    });
    const links: Array<{ rel: string; href: string }> = data.links ?? [];
    return {
      provider: this.name,
      id: data.id,
      reference,
      url: links.find((l) => l.rel === 'payer-action')?.href ?? links.find((l) => l.rel === 'approve')?.href,
      raw: data,
    };
  }

  async getPayment(orderId: string): Promise<Payment> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(requireNonEmpty(orderId, 'paymentId'))}`,
      headers: await this.authHeaders(),
    });
    return this.fromOrder(data);
  }

  async findByReference(): Promise<Payment | null> {
    throw new UnsupportedOperationError(
      this.name,
      'findByReference',
      'PayPal has no order search API; store the order id',
    );
  }

  /** Captures an approved order. Idempotent: repeated calls return the captured order. */
  async capture(orderId: string): Promise<Payment> {
    const id = requireNonEmpty(orderId, 'paymentId');
    try {
      const { data } = await this.http.request<Record<string, any>>({
        method: 'POST',
        url: `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
        headers: await this.authHeaders(`capture-${id}`),
        json: {},
      });
      return this.fromOrder(data);
    } catch (error) {
      const issue = (error as ProviderError).raw as { details?: Array<{ issue?: string }> } | undefined;
      if (error instanceof ProviderError && issue?.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) {
        return this.getPayment(id);
      }
      throw error;
    }
  }

  async refund(request: RefundRequest): Promise<Refund> {
    const orderId = requireNonEmpty(request.paymentId, 'paymentId');
    const payment = await this.getPayment(orderId);
    const unit = (payment.raw as any)?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.find(
      (c: any) => c.status === 'COMPLETED' || c.status === 'PARTIALLY_REFUNDED',
    );
    if (!capture) throw new PaymentValidationError(`paypal: order ${orderId} has no completed capture to refund`);

    const body: Record<string, unknown> = {};
    if (request.amount !== undefined) {
      assertMinorUnits(request.amount);
      body.amount = {
        currency_code: capture.amount.currency_code,
        value: this.toValue(request.amount, capture.amount.currency_code),
      };
    }
    if (request.reason) body.note_to_payer = request.reason.slice(0, 255);

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`,
      headers: await this.authHeaders(request.idempotencyKey),
      json: body,
    });
    const currency = data.amount?.currency_code ?? capture.amount.currency_code;
    return {
      provider: this.name,
      id: data.id,
      paymentId: orderId,
      status: data.status === 'COMPLETED' ? 'succeeded' : data.status === 'PENDING' ? 'pending' : 'failed',
      amount: data.amount?.value ? toMinorUnits(data.amount.value, currency) : request.amount,
      currency,
      raw: data,
    };
  }

  private async certificate(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WebhookVerificationError(this.name, 'invalid paypal-cert-url');
    }
    // Never trust a certificate from an attacker-controlled host.
    if (
      parsed.protocol !== 'https:' ||
      !CERT_HOST.test(parsed.hostname) ||
      !parsed.pathname.startsWith('/v1/notifications/certs/')
    ) {
      throw new WebhookVerificationError(this.name, `untrusted certificate URL ${parsed.hostname}`);
    }
    if (!this.certificates.has(url)) {
      const download =
        this.config.fetchCertificate ??
        (async (certUrl: string) => {
          const fetchImpl = (this.config.http?.fetch ?? globalThis.fetch) as FetchLike;
          const response = await fetchImpl(certUrl, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        });
      const pending = download(url).catch((error) => {
        this.certificates.delete(url);
        throw new WebhookVerificationError(this.name, `could not download certificate: ${(error as Error).message}`);
      });
      this.certificates.set(url, pending);
    }
    return this.certificates.get(url)!;
  }

  /**
   * Self-verification per developer.paypal.com/api/rest/webhooks/rest:
   * RSA-SHA256 over `transmissionId|transmissionTime|webhookId|crc32(rawBody)`.
   */
  async verifySignature(request: WebhookRequest): Promise<void> {
    const webhookId = this.config.webhookId;
    if (!webhookId) throw new WebhookVerificationError(this.name, 'webhookId is not configured');

    const transmissionId = getHeader(request.headers, 'paypal-transmission-id');
    const transmissionTime = getHeader(request.headers, 'paypal-transmission-time');
    const signature = getHeader(request.headers, 'paypal-transmission-sig');
    const certUrl = getHeader(request.headers, 'paypal-cert-url');
    const algorithm = getHeader(request.headers, 'paypal-auth-algo');
    if (!transmissionId || !transmissionTime || !signature || !certUrl) {
      throw new WebhookVerificationError(this.name, 'missing PayPal transmission headers');
    }
    if (algorithm && algorithm.toUpperCase() !== 'SHA256WITHRSA') {
      throw new WebhookVerificationError(this.name, `unsupported auth algorithm ${algorithm}`);
    }

    const pem = await this.certificate(certUrl);
    if (pem.includes('BEGIN CERTIFICATE')) {
      const certificate = new X509Certificate(pem);
      if (new Date(certificate.validTo).getTime() < Date.now()) {
        throw new WebhookVerificationError(this.name, 'signing certificate expired');
      }
    }

    const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBodyToString(request.rawBody))}`;
    let valid: boolean;
    try {
      valid = createVerify('sha256').update(message).verify(pem, Buffer.from(signature, 'base64'));
    } catch {
      // Malformed PEM or signature: treat as unverifiable.
      valid = false;
    }
    if (!valid) throw new WebhookVerificationError(this.name, 'signature mismatch (is the raw body intact?)');
  }

  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    await this.verifySignature(request);
    const event = parseJsonWebhook(this.name, request);
    const eventType = String(event?.event_type ?? '');
    const resource = event?.resource ?? {};

    const types: Record<string, PaymentEventType> = {
      'CHECKOUT.ORDER.APPROVED': 'payment.authorized',
      'CHECKOUT.ORDER.COMPLETED': 'payment.succeeded',
      'PAYMENT.CAPTURE.COMPLETED': 'payment.succeeded',
      'PAYMENT.CAPTURE.PENDING': 'payment.pending',
      'PAYMENT.CAPTURE.DENIED': 'payment.failed',
      'PAYMENT.CAPTURE.DECLINED': 'payment.failed',
      'PAYMENT.CAPTURE.REFUNDED': 'payment.refunded',
      'PAYMENT.CAPTURE.REVERSED': 'payment.refunded',
    };
    const type = types[eventType] ?? 'unknown';

    const isOrder = eventType.startsWith('CHECKOUT.ORDER.');
    const unit = resource.purchase_units?.[0];
    const money = isOrder ? unit?.amount : resource.amount;
    const currency: string | undefined = money?.currency_code;

    return {
      provider: this.name,
      id: String(event?.id),
      type,
      providerType: eventType,
      paymentId: isOrder ? resource.id : resource.supplementary_data?.related_ids?.order_id,
      reference: isOrder ? (unit?.custom_id ?? unit?.reference_id) : resource.custom_id,
      status: type === 'unknown' ? undefined : (type.slice('payment.'.length) as PaymentStatus),
      amount: money?.value && currency ? toMinorUnits(money.value, currency) : undefined,
      currency,
      occurredAt: dateFromIso(event?.create_time),
      raw: event,
    };
  }

  private fromOrder(order: Record<string, any>): Payment {
    const unit = order.purchase_units?.[0] ?? {};
    const captures: any[] = unit.payments?.captures ?? [];
    const refunds: any[] = unit.payments?.refunds ?? [];
    const currency: string | undefined = unit.amount?.currency_code;
    const capture = captures[captures.length - 1];

    let status: PaymentStatus;
    switch (order.status) {
      case 'APPROVED':
        status = 'authorized';
        break;
      case 'VOIDED':
        status = 'canceled';
        break;
      case 'COMPLETED':
        status =
          (
            {
              COMPLETED: 'succeeded',
              PENDING: 'pending',
              DECLINED: 'failed',
              FAILED: 'failed',
              REFUNDED: 'refunded',
              PARTIALLY_REFUNDED: 'partially_refunded',
            } as Record<string, PaymentStatus>
          )[capture?.status] ?? 'succeeded';
        break;
      default:
        status = 'pending';
    }

    const refunded =
      currency && refunds.length
        ? refunds
            .filter((r) => r.status === 'COMPLETED')
            .reduce((sum, r) => sum + toMinorUnits(r.amount.value, currency), 0)
        : 0;

    return {
      provider: this.name,
      id: order.id,
      reference: unit.custom_id ?? unit.reference_id,
      status,
      amount: unit.amount?.value && currency ? toMinorUnits(unit.amount.value, currency) : undefined,
      currency,
      amountRefunded: refunded || undefined,
      method: order.payment_source ? Object.keys(order.payment_source)[0] : undefined,
      createdAt: dateFromIso(order.create_time),
      raw: order,
    };
  }
}
