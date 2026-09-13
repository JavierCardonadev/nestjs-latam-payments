import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import { PaymentsConfigurationError, WebhookVerificationError } from '../../core/errors.js';
import { getHeader, HttpClient, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency, toDecimalString, toMinorUnits } from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  PaymentStatus,
  ProviderCapabilities,
  Refund,
  RefundRequest,
  WebhookRequest,
} from '../../core/types.js';
import {
  dateFromIso,
  eventTypeForStatus,
  parseJsonWebhook,
  queryValue,
  requireConfig,
  requireNonEmpty,
} from '../../core/utils.js';

export interface MercadoPagoConfig {
  /** APP_USR-... (production) or TEST-... credentials. */
  accessToken: string;
  /**
   * "Secret signature" from Your integrations > Webhooks. Strongly recommended.
   * Without it webhooks can't be authenticated, so events are only accepted when
   * `hydrateWebhooks` is on (the status is then fetched from Mercado Pago itself).
   */
  webhookSecret?: string;
  /** Reject notifications whose `ts` drifts more than this many seconds. */
  webhookToleranceSeconds?: number;
  /** Fetch the payment from the API when a webhook arrives. Default: true. */
  hydrateWebhooks?: boolean;
  /** Redirect to `sandbox_init_point` instead of `init_point`. Default: false. */
  useSandboxInitPoint?: boolean;
  statementDescriptor?: string;
  baseUrl?: string;
  http?: HttpClientOptions;
}

const STATUS: Record<string, PaymentStatus> = {
  pending: 'pending',
  in_process: 'pending',
  in_mediation: 'pending',
  authorized: 'authorized',
  approved: 'succeeded',
  rejected: 'failed',
  cancelled: 'canceled',
  refunded: 'refunded',
  charged_back: 'refunded',
};

/** Mercado Pago (AR, BR, CL, CO, MX, PE, UY): Checkout Pro, Pix, cash and cards. */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';
  readonly capabilities: ProviderCapabilities = {
    checkout: true,
    getPayment: true,
    findByReference: true,
    refund: true,
    partialRefund: true,
    capture: false,
    webhooks: true,
  };

  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(private readonly config: MercadoPagoConfig) {
    requireConfig(this.name, config, ['accessToken']);
    if (!config.webhookSecret && config.hydrateWebhooks === false) {
      throw new PaymentsConfigurationError(
        'mercadopago: set `webhookSecret` or keep `hydrateWebhooks` enabled, otherwise webhooks cannot be trusted',
      );
    }
    this.baseUrl = config.baseUrl ?? 'https://api.mercadopago.com';
    this.http = new HttpClient(this.name, config.http);
  }

  private get auth() {
    return { Authorization: `Bearer ${this.config.accessToken}` };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    assertMinorUnits(request.amount);
    const currency = normalizeCurrency(request.currency);

    const body: Record<string, unknown> = {
      items: [
        {
          id: reference,
          title: request.description ?? `Order ${reference}`,
          quantity: 1,
          currency_id: currency,
          unit_price: Number(toDecimalString(request.amount, currency)),
        },
      ],
      external_reference: reference,
      metadata: { ...request.metadata, reference },
      statement_descriptor: this.config.statementDescriptor,
      notification_url: request.notificationUrl,
    };
    if (request.customer?.email || request.customer?.name) {
      body.payer = { email: request.customer.email, name: request.customer.name };
    }
    if (request.successUrl || request.cancelUrl) {
      body.back_urls = {
        success: request.successUrl,
        pending: request.successUrl,
        failure: request.cancelUrl ?? request.successUrl,
      };
      if (request.successUrl) body.auto_return = 'approved';
    }
    if (request.expiresAt) {
      body.expires = true;
      body.expiration_date_to = request.expiresAt.toISOString();
    }
    Object.assign(body, request.providerOptions);

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/checkout/preferences`,
      headers: { ...this.auth, 'X-Idempotency-Key': request.idempotencyKey },
      json: body,
    });

    return {
      provider: this.name,
      id: String(data.id),
      reference,
      url: this.config.useSandboxInitPoint ? data.sandbox_init_point : data.init_point,
      expiresAt: request.expiresAt,
      raw: data,
    };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    const { data } = await this.http.request<MercadoPagoPayment>({
      method: 'GET',
      url: `${this.baseUrl}/v1/payments/${encodeURIComponent(requireNonEmpty(paymentId, 'paymentId'))}`,
      headers: this.auth,
    });
    return this.toPayment(data);
  }

  async findByReference(reference: string): Promise<Payment | null> {
    const { data } = await this.http.request<{ results?: MercadoPagoPayment[] }>({
      method: 'GET',
      url: `${this.baseUrl}/v1/payments/search`,
      headers: this.auth,
      query: {
        external_reference: requireNonEmpty(reference, 'reference'),
        sort: 'date_created',
        criteria: 'desc',
        limit: 1,
      },
    });
    const latest = data.results?.[0];
    return latest ? this.toPayment(latest) : null;
  }

  async refund(request: RefundRequest): Promise<Refund> {
    const paymentId = requireNonEmpty(request.paymentId, 'paymentId');
    let body: Record<string, number> | undefined;
    let currency: string | undefined;
    if (request.amount !== undefined) {
      assertMinorUnits(request.amount);
      currency = (await this.getPayment(paymentId)).currency;
      body = { amount: Number(toDecimalString(request.amount, currency ?? 'USD')) };
    }

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      // Mercado Pago requires an idempotency key on refunds.
      headers: { ...this.auth, 'X-Idempotency-Key': request.idempotencyKey ?? randomUUID() },
      json: body ?? {},
    });

    const status = String(data.status ?? '');
    return {
      provider: this.name,
      id: String(data.id),
      paymentId,
      status:
        status === 'approved' ? 'succeeded' : status === 'rejected' || status === 'cancelled' ? 'failed' : 'pending',
      amount: data.amount !== undefined && currency ? toMinorUnits(data.amount, currency) : request.amount,
      currency,
      raw: data,
    };
  }

  /**
   * Validates `x-signature` exactly like the official SDK
   * (mercadopago/sdk-nodejs `src/utils/webhook`): HMAC-SHA256 over
   * `id:{data.id};request-id:{x-request-id};ts:{ts};`, omitting absent parts.
   */
  verifySignature(request: WebhookRequest, dataId: string | undefined): void {
    const secret = this.config.webhookSecret;
    if (!secret) return;

    const header = getHeader(request.headers, 'x-signature');
    if (!header) throw new WebhookVerificationError(this.name, 'missing x-signature header');

    let ts: string | undefined;
    let v1: string | undefined;
    for (const part of header.split(',')) {
      const index = part.indexOf('=');
      if (index === -1) continue;
      const key = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim();
      if (key === 'ts') ts = value;
      if (key === 'v1') v1 = value;
    }
    if (!ts || !/^\d+$/.test(ts) || !v1) {
      throw new WebhookVerificationError(this.name, 'malformed x-signature header');
    }

    const requestId = getHeader(request.headers, 'x-request-id');
    const manifest = (id: string | undefined) =>
      [id && `id:${id}`, requestId && `request-id:${requestId}`, `ts:${ts}`].filter(Boolean).join(';') + ';';

    // Mercado Pago's docs ask for alphanumeric ids in lowercase; the SDK hashes the id as received.
    const candidates = new Set([dataId, dataId?.toLowerCase()]);
    const valid = [...candidates].some((id) => safeEqual(hmacSha256Hex(secret, manifest(id)), v1));
    if (!valid) throw new WebhookVerificationError(this.name, 'signature mismatch');

    const tolerance = this.config.webhookToleranceSeconds;
    if (tolerance !== undefined && Math.abs(Date.now() / 1000 - Number(ts)) > tolerance) {
      throw new WebhookVerificationError(this.name, 'timestamp outside tolerance');
    }
  }

  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    const body = parseJsonWebhook(this.name, request);
    const dataId =
      queryValue(request.query, 'data.id') ?? (body?.data?.id !== undefined ? String(body.data.id) : undefined);
    this.verifySignature(request, dataId);

    const topic = String(body?.type ?? body?.topic ?? queryValue(request.query, 'type') ?? '');
    const providerType = String(body?.action ?? topic);
    const hydrate = this.config.hydrateWebhooks !== false;

    let payment: Payment | undefined;
    if (topic === 'payment' && dataId && hydrate) {
      payment = await this.getPayment(dataId);
    }

    return {
      provider: this.name,
      id: String(body?.id ?? getHeader(request.headers, 'x-request-id') ?? `${topic}:${dataId}`),
      type: eventTypeForStatus(payment?.status),
      providerType,
      paymentId: topic === 'payment' ? dataId : undefined,
      reference: payment?.reference,
      status: payment?.status,
      amount: payment?.amount,
      currency: payment?.currency,
      occurredAt: dateFromIso(body?.date_created),
      payment,
      raw: body,
    };
  }

  private toPayment(data: MercadoPagoPayment): Payment {
    const currency = data.currency_id;
    const amount =
      currency && data.transaction_amount !== undefined ? toMinorUnits(data.transaction_amount, currency) : undefined;
    const refunded =
      currency && data.transaction_amount_refunded ? toMinorUnits(data.transaction_amount_refunded, currency) : 0;

    let status = STATUS[String(data.status)] ?? 'pending';
    if (status === 'succeeded' && refunded > 0) {
      status = amount !== undefined && refunded >= amount ? 'refunded' : 'partially_refunded';
    }

    return {
      provider: this.name,
      id: String(data.id),
      reference: data.external_reference ?? undefined,
      status,
      amount,
      currency,
      amountRefunded: refunded || undefined,
      method: data.payment_method_id ?? data.payment_type_id,
      createdAt: dateFromIso(data.date_created),
      raw: data,
    };
  }
}

export interface MercadoPagoPayment {
  id: number | string;
  status: string;
  status_detail?: string;
  transaction_amount?: number;
  transaction_amount_refunded?: number;
  currency_id?: string;
  external_reference?: string | null;
  payment_method_id?: string;
  payment_type_id?: string;
  date_created?: string;
  [key: string]: unknown;
}
