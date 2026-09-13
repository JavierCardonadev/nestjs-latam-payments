import { hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import { PaymentValidationError, WebhookVerificationError } from '../../core/errors.js';
import { getHeader, HttpClient, rawBodyToString, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency } from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  PaymentEventType,
  PaymentStatus,
  ProviderCapabilities,
  Refund,
  RefundRequest,
  WebhookRequest,
} from '../../core/types.js';
import { dateFromUnixSeconds, parseJsonWebhook, requireConfig, requireNonEmpty } from '../../core/utils.js';

export interface StripeConfig {
  /** sk_test_... / sk_live_... (or a restricted key rk_...). */
  secretKey: string;
  /** whsec_... from the webhook endpoint. */
  webhookSecret?: string;
  /** Seconds a signed event stays valid. Default 300, like the official SDK. */
  webhookToleranceSeconds?: number;
  /** Pin a Stripe API version, e.g. "2026-08-27.basil". Defaults to your account version. */
  apiVersion?: string;
  baseUrl?: string;
  http?: HttpClientOptions;
}

const INTENT_STATUS: Record<string, PaymentStatus> = {
  requires_payment_method: 'pending',
  requires_confirmation: 'pending',
  requires_action: 'requires_action',
  processing: 'pending',
  requires_capture: 'authorized',
  canceled: 'canceled',
  succeeded: 'succeeded',
};

/** Stripe Checkout (cards, Pix/Boleto/OXXO where enabled, wallets). */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
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

  constructor(private readonly config: StripeConfig) {
    requireConfig(this.name, config, ['secretKey']);
    this.baseUrl = config.baseUrl ?? 'https://api.stripe.com';
    this.http = new HttpClient(this.name, config.http);
  }

  private headers(idempotencyKey?: string) {
    return {
      Authorization: `Bearer ${this.config.secretKey}`,
      'Stripe-Version': this.config.apiVersion,
      'Idempotency-Key': idempotencyKey,
    };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    assertMinorUnits(request.amount);
    const currency = normalizeCurrency(request.currency).toLowerCase();
    if (!request.successUrl) {
      throw new PaymentValidationError('stripe: successUrl is required for hosted Checkout');
    }

    const metadata = { ...request.metadata, reference };
    const params: Record<string, unknown> = {
      mode: 'payment',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      client_reference_id: reference,
      customer_email: request.customer?.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: request.amount,
            product_data: { name: request.description ?? `Order ${reference}` },
          },
        },
      ],
      metadata,
      payment_intent_data: { metadata, description: request.description },
      expires_at: request.expiresAt ? Math.floor(request.expiresAt.getTime() / 1000) : undefined,
      ...request.providerOptions,
    };

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/checkout/sessions`,
      headers: this.headers(request.idempotencyKey),
      form: toFormParams(params),
    });

    return {
      provider: this.name,
      id: data.id,
      reference,
      url: data.url,
      expiresAt: dateFromUnixSeconds(data.expires_at),
      raw: data,
    };
  }

  /** Accepts a PaymentIntent id (`pi_...`) or a Checkout Session id (`cs_...`). */
  async getPayment(paymentId: string): Promise<Payment> {
    const id = requireNonEmpty(paymentId, 'paymentId');
    if (id.startsWith('cs_')) {
      const { data } = await this.http.request<Record<string, any>>({
        method: 'GET',
        url: `${this.baseUrl}/v1/checkout/sessions/${encodeURIComponent(id)}`,
        headers: this.headers(),
        query: { 'expand[0]': 'payment_intent', 'expand[1]': 'payment_intent.latest_charge' },
      });
      return this.fromSession(data);
    }
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(id)}`,
      headers: this.headers(),
      query: { 'expand[0]': 'latest_charge' },
    });
    return this.fromIntent(data);
  }

  /** Uses the Search API (`metadata['reference']`). Search results can lag ~1 minute. */
  async findByReference(reference: string): Promise<Payment | null> {
    const value = requireNonEmpty(reference, 'reference').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { data } = await this.http.request<{ data?: Array<Record<string, any>> }>({
      method: 'GET',
      url: `${this.baseUrl}/v1/payment_intents/search`,
      headers: this.headers(),
      query: { query: `metadata['reference']:'${value}'`, limit: 1, 'expand[0]': 'data.latest_charge' },
    });
    const intent = data.data?.[0];
    return intent ? this.fromIntent(intent) : null;
  }

  async refund(request: RefundRequest): Promise<Refund> {
    let paymentIntent = requireNonEmpty(request.paymentId, 'paymentId');
    if (paymentIntent.startsWith('cs_')) {
      const payment = await this.getPayment(paymentIntent);
      paymentIntent = payment.id;
      if (!paymentIntent.startsWith('pi_')) {
        throw new PaymentValidationError('stripe: this Checkout Session has no PaymentIntent to refund yet');
      }
    }
    if (request.amount !== undefined) assertMinorUnits(request.amount);

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/refunds`,
      headers: this.headers(request.idempotencyKey),
      form: toFormParams({
        payment_intent: paymentIntent,
        amount: request.amount,
        reason: 'requested_by_customer',
        metadata: request.reason ? { reason: request.reason } : undefined,
      }),
    });

    return {
      provider: this.name,
      id: data.id,
      paymentId: paymentIntent,
      status:
        data.status === 'succeeded'
          ? 'succeeded'
          : data.status === 'failed' || data.status === 'canceled'
            ? 'failed'
            : 'pending',
      amount: data.amount,
      currency: data.currency?.toUpperCase(),
      raw: data,
    };
  }

  /** Same algorithm as stripe-node `Webhooks.constructEvent`. */
  verifySignature(request: WebhookRequest): void {
    const secret = this.config.webhookSecret;
    if (!secret) throw new WebhookVerificationError(this.name, 'webhookSecret is not configured');

    const header = getHeader(request.headers, 'stripe-signature');
    if (!header) throw new WebhookVerificationError(this.name, 'missing Stripe-Signature header');

    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [key, value] = part.split('=', 2).map((s) => s.trim());
      if (key === 't') timestamp = value;
      if (key === 'v1' && value) signatures.push(value);
    }
    if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
      throw new WebhookVerificationError(this.name, 'malformed Stripe-Signature header');
    }

    const expected = hmacSha256Hex(secret, `${timestamp}.${rawBodyToString(request.rawBody)}`);
    if (!signatures.some((signature) => safeEqual(expected, signature, { ignoreCase: false }))) {
      throw new WebhookVerificationError(this.name, 'signature mismatch (is the raw body intact?)');
    }

    const tolerance = this.config.webhookToleranceSeconds ?? 300;
    if (tolerance > 0 && Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance) {
      throw new WebhookVerificationError(this.name, 'timestamp outside tolerance');
    }
  }

  async parseWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    this.verifySignature(request);
    const event = parseJsonWebhook(this.name, request);
    const object = event?.data?.object ?? {};
    const eventType = String(event?.type ?? '');

    let type: PaymentEventType = 'unknown';
    let paymentId: string | undefined;
    let reference: string | undefined = object.metadata?.reference;
    let amount: number | undefined;

    if (eventType.startsWith('checkout.session.')) {
      paymentId =
        typeof object.payment_intent === 'string' ? object.payment_intent : (object.payment_intent?.id ?? object.id);
      reference = object.client_reference_id ?? reference;
      amount = object.amount_total;
      type =
        eventType === 'checkout.session.completed'
          ? object.payment_status === 'unpaid'
            ? 'payment.pending'
            : 'payment.succeeded'
          : eventType === 'checkout.session.async_payment_succeeded'
            ? 'payment.succeeded'
            : eventType === 'checkout.session.async_payment_failed'
              ? 'payment.failed'
              : eventType === 'checkout.session.expired'
                ? 'payment.expired'
                : 'unknown';
    } else if (eventType.startsWith('payment_intent.')) {
      paymentId = object.id;
      amount = object.amount;
      type =
        (
          {
            'payment_intent.succeeded': 'payment.succeeded',
            'payment_intent.payment_failed': 'payment.failed',
            'payment_intent.canceled': 'payment.canceled',
            'payment_intent.processing': 'payment.pending',
            'payment_intent.requires_action': 'payment.pending',
            'payment_intent.amount_capturable_updated': 'payment.authorized',
          } as Record<string, PaymentEventType>
        )[eventType] ?? 'unknown';
    } else if (eventType === 'charge.refunded') {
      paymentId = object.payment_intent ?? object.id;
      amount = object.amount;
      type = object.amount_refunded >= object.amount ? 'payment.refunded' : 'payment.partially_refunded';
    }

    return {
      provider: this.name,
      id: String(event?.id),
      type,
      providerType: eventType,
      paymentId,
      reference,
      status: type === 'unknown' ? undefined : (type.slice('payment.'.length) as PaymentStatus),
      amount,
      currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined,
      occurredAt: dateFromUnixSeconds(event?.created),
      raw: event,
    };
  }

  private fromIntent(intent: Record<string, any>): Payment {
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : undefined;
    let status: PaymentStatus = INTENT_STATUS[intent.status] ?? 'pending';
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) status = 'failed';
    const refunded = charge?.amount_refunded ?? 0;
    if (status === 'succeeded' && refunded > 0) {
      status = refunded >= intent.amount ? 'refunded' : 'partially_refunded';
    }
    return {
      provider: this.name,
      id: intent.id,
      reference: intent.metadata?.reference,
      status,
      amount: intent.amount,
      currency: intent.currency?.toUpperCase(),
      amountRefunded: refunded || undefined,
      method: charge?.payment_method_details?.type ?? intent.payment_method_types?.[0],
      createdAt: dateFromUnixSeconds(intent.created),
      raw: intent,
    };
  }

  private fromSession(session: Record<string, any>): Payment {
    if (session.payment_intent && typeof session.payment_intent === 'object') {
      const payment = this.fromIntent(session.payment_intent);
      return { ...payment, reference: session.client_reference_id ?? payment.reference, raw: session };
    }
    const status: PaymentStatus =
      session.status === 'expired'
        ? 'expired'
        : session.status === 'complete' && session.payment_status !== 'unpaid'
          ? 'succeeded'
          : 'pending';
    return {
      provider: this.name,
      id: session.id,
      reference: session.client_reference_id ?? session.metadata?.reference,
      status,
      amount: session.amount_total,
      currency: session.currency?.toUpperCase(),
      createdAt: dateFromUnixSeconds(session.created),
      raw: session,
    };
  }
}

/** Flattens nested objects/arrays into Stripe's bracket notation: `a[b][0][c]=v`. */
export function toFormParams(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${key}[${index}]`));
    } else if (value instanceof Date) {
      params.append(key, String(Math.floor(value.getTime() / 1000)));
    } else if (typeof value === 'object') {
      for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
        walk(childValue, `${key}[${child}]`);
      }
    } else {
      params.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(input)) walk(value, key);
  return params;
}
