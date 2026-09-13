import { hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import { PaymentValidationError, UnsupportedOperationError, WebhookVerificationError } from '../../core/errors.js';
import { getHeader, HttpClient, rawBodyToString, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency } from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import { normalizePlan, subscriptionEventForStatus } from '../../core/subscriptions.js';
import type {
  BillingInterval,
  CancelSubscriptionRequest,
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  PaymentEventType,
  PaymentStatus,
  Plan,
  PlanRequest,
  ProviderCapabilities,
  Refund,
  RefundRequest,
  Subscription,
  SubscriptionRequest,
  SubscriptionSession,
  SubscriptionStatus,
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

const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  incomplete: 'pending',
  incomplete_expired: 'expired',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
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
    subscriptions: true,
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

    let subscriptionId: string | undefined;
    let subscription: Subscription | undefined;

    if (eventType.startsWith('checkout.session.') && object.mode === 'subscription') {
      // The lifecycle is reported by customer.subscription.* and invoice.* events.
      subscriptionId = idOf(object.subscription);
      reference = object.client_reference_id ?? reference;
    } else if (eventType.startsWith('customer.subscription.')) {
      subscription = this.toSubscription(object);
      subscriptionId = subscription.id;
      reference = subscription.reference;
      amount = subscription.amount;
      type = this.subscriptionEventType(eventType, event?.data?.previous_attributes, subscription.status);
    } else if (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed') {
      // API versions from 2025-03 (basil) moved these under invoice.parent.subscription_details.
      const details = object.parent?.subscription_details ?? object.subscription_details;
      subscriptionId = idOf(details?.subscription ?? object.subscription);
      if (subscriptionId) {
        paymentId = object.id;
        reference = details?.metadata?.reference ?? reference;
        const paid = eventType === 'invoice.paid';
        amount = paid ? object.amount_paid : object.amount_due;
        type = paid ? 'subscription.payment_succeeded' : 'subscription.payment_failed';
      }
    } else if (eventType.startsWith('checkout.session.')) {
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
      status: type.startsWith('payment.') ? (type.slice('payment.'.length) as PaymentStatus) : undefined,
      amount,
      currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : subscription?.currency,
      occurredAt: dateFromUnixSeconds(event?.created),
      subscriptionId,
      subscription,
      raw: event,
    };
  }

  private subscriptionEventType(
    eventType: string,
    previous: Record<string, unknown> | undefined,
    status: SubscriptionStatus,
  ): PaymentEventType {
    switch (eventType) {
      case 'customer.subscription.created':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        return subscriptionEventForStatus(status);
      case 'customer.subscription.deleted':
        return 'subscription.canceled';
      case 'customer.subscription.updated':
        // Only a status (or pause) change is a lifecycle transition; anything else is an update.
        return previous && ('status' in previous || 'pause_collection' in previous)
          ? subscriptionEventForStatus(status)
          : 'subscription.updated';
      default:
        return 'unknown';
    }
  }

  /** Creates a recurring Price (with its Product). The returned id is the price id. */
  async createPlan(request: PlanRequest): Promise<Plan> {
    const plan = normalizePlan(request);
    this.assertNoTotalCycles(plan.totalCycles);
    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/prices`,
      headers: this.headers(request.idempotencyKey),
      form: toFormParams({
        currency: plan.currency.toLowerCase(),
        unit_amount: plan.amount,
        recurring: { interval: plan.interval, interval_count: plan.intervalCount },
        product_data: { name: plan.name },
        // Trials are applied per subscription in Stripe; the plan remembers the default.
        metadata: { ...request.metadata, trial_days: plan.trialDays?.toString() },
        expand: ['product'],
        ...request.providerOptions,
      }),
    });
    return this.toPlan(data);
  }

  async getPlan(planId: string): Promise<Plan> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v1/prices/${encodeURIComponent(requireNonEmpty(planId, 'planId'))}`,
      headers: this.headers(),
      query: { 'expand[0]': 'product' },
    });
    return this.toPlan(data);
  }

  /** Hosted Checkout in subscription mode. The subscription id arrives with `customer.subscription.created`. */
  async createSubscription(request: SubscriptionRequest): Promise<SubscriptionSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    if (!request.successUrl) {
      throw new PaymentValidationError('stripe: successUrl is required for hosted Checkout');
    }

    let lineItem: Record<string, unknown>;
    let trialDays: number | undefined;
    if (typeof request.plan === 'string') {
      const plan = await this.getPlan(request.plan);
      lineItem = { price: plan.id, quantity: 1 };
      trialDays = plan.trialDays;
    } else {
      const plan = normalizePlan(request.plan);
      this.assertNoTotalCycles(plan.totalCycles);
      lineItem = {
        quantity: 1,
        price_data: {
          currency: plan.currency.toLowerCase(),
          unit_amount: plan.amount,
          recurring: { interval: plan.interval, interval_count: plan.intervalCount },
          product_data: { name: plan.name },
        },
      };
      trialDays = plan.trialDays;
    }

    const metadata = { ...request.metadata, reference };
    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/checkout/sessions`,
      headers: this.headers(request.idempotencyKey),
      form: toFormParams({
        mode: 'subscription',
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: reference,
        customer_email: request.customer?.email,
        line_items: [lineItem],
        metadata,
        subscription_data: { metadata, trial_period_days: trialDays || undefined },
        ...request.providerOptions,
      }),
    });
    return { provider: this.name, id: data.id, reference, url: data.url, raw: data };
  }

  /** Accepts a subscription id (`sub_…`) or the Checkout Session id returned by `createSubscription`. */
  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const id = requireNonEmpty(subscriptionId, 'subscriptionId');
    if (id.startsWith('cs_')) {
      const { data: session } = await this.http.request<Record<string, any>>({
        method: 'GET',
        url: `${this.baseUrl}/v1/checkout/sessions/${encodeURIComponent(id)}`,
        headers: this.headers(),
        query: { 'expand[0]': 'subscription' },
      });
      if (session.subscription && typeof session.subscription === 'object') {
        return this.toSubscription(session.subscription);
      }
      return {
        provider: this.name,
        id: session.id,
        reference: session.client_reference_id ?? session.metadata?.reference,
        status: session.status === 'expired' ? 'expired' : 'pending',
        createdAt: dateFromUnixSeconds(session.created),
        raw: session,
      };
    }
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v1/subscriptions/${encodeURIComponent(id)}`,
      headers: this.headers(),
    });
    return this.toSubscription(data);
  }

  /** Uses the Search API (`metadata['reference']`). Search results can lag ~1 minute. */
  async findSubscriptionByReference(reference: string): Promise<Subscription | null> {
    const value = requireNonEmpty(reference, 'reference').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { data } = await this.http.request<{ data?: Array<Record<string, any>> }>({
      method: 'GET',
      url: `${this.baseUrl}/v1/subscriptions/search`,
      headers: this.headers(),
      query: { query: `metadata['reference']:'${value}'`, limit: 1 },
    });
    const subscription = data.data?.[0];
    return subscription ? this.toSubscription(subscription) : null;
  }

  async cancelSubscription(request: CancelSubscriptionRequest): Promise<Subscription> {
    const id = encodeURIComponent(requireNonEmpty(request.subscriptionId, 'subscriptionId'));
    const details = request.reason ? { comment: request.reason.slice(0, 5000) } : undefined;
    const { data } = request.atPeriodEnd
      ? await this.http.request<Record<string, any>>({
          method: 'POST',
          url: `${this.baseUrl}/v1/subscriptions/${id}`,
          headers: this.headers(),
          form: toFormParams({ cancel_at_period_end: true, cancellation_details: details }),
        })
      : await this.http.request<Record<string, any>>({
          method: 'DELETE',
          url: `${this.baseUrl}/v1/subscriptions/${id}`,
          headers: this.headers(),
          query: details ? { 'cancellation_details[comment]': details.comment } : undefined,
        });
    return this.toSubscription(data);
  }

  /** Pauses collection: invoices are voided until resumed. */
  async pauseSubscription(subscriptionId: string): Promise<Subscription> {
    return this.updateSubscription(subscriptionId, { pause_collection: { behavior: 'void' } });
  }

  async resumeSubscription(subscriptionId: string): Promise<Subscription> {
    // An empty value unsets pause_collection.
    return this.updateSubscription(subscriptionId, { pause_collection: '' });
  }

  private async updateSubscription(subscriptionId: string, params: Record<string, unknown>): Promise<Subscription> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/subscriptions/${encodeURIComponent(requireNonEmpty(subscriptionId, 'subscriptionId'))}`,
      headers: this.headers(),
      form: toFormParams(params),
    });
    return this.toSubscription(data);
  }

  private assertNoTotalCycles(totalCycles: number | undefined): void {
    if (totalCycles !== undefined) {
      throw new UnsupportedOperationError(
        this.name,
        'totalCycles',
        'Stripe prices renew until canceled; use a Subscription Schedule via providerOptions',
      );
    }
  }

  private toPlan(price: Record<string, any>): Plan {
    const trialDays = price.metadata?.trial_days ?? price.recurring?.trial_period_days;
    return {
      provider: this.name,
      id: price.id,
      name: typeof price.product === 'object' ? price.product?.name : (price.nickname ?? undefined),
      amount: price.unit_amount ?? undefined,
      currency: price.currency?.toUpperCase(),
      interval: price.recurring?.interval as BillingInterval | undefined,
      intervalCount: price.recurring?.interval_count,
      trialDays: trialDays !== undefined && trialDays !== null && trialDays !== '' ? Number(trialDays) : undefined,
      active: price.active !== false,
      raw: price,
    };
  }

  private toSubscription(sub: Record<string, any>): Subscription {
    const item = sub.items?.data?.[0];
    const price = item?.price;
    let status: SubscriptionStatus = SUBSCRIPTION_STATUS[sub.status] ?? 'pending';
    if (status === 'active' && sub.pause_collection) status = 'paused';
    // API versions from 2025-03 (basil) moved the billing period to each subscription item.
    const periodEnd = sub.current_period_end ?? item?.current_period_end;
    const renews = (status === 'active' || status === 'past_due') && !sub.cancel_at_period_end;

    return {
      provider: this.name,
      id: sub.id,
      reference: sub.metadata?.reference,
      status,
      planId: price?.id,
      amount: typeof price?.unit_amount === 'number' ? price.unit_amount * (item.quantity ?? 1) : undefined,
      currency: (price?.currency ?? sub.currency)?.toUpperCase(),
      interval: price?.recurring?.interval,
      intervalCount: price?.recurring?.interval_count,
      currentPeriodEnd: dateFromUnixSeconds(periodEnd),
      nextBillingAt: dateFromUnixSeconds(status === 'trialing' ? sub.trial_end : renews ? periodEnd : undefined),
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      canceledAt: dateFromUnixSeconds(sub.canceled_at),
      customerEmail: typeof sub.customer === 'object' ? (sub.customer?.email ?? undefined) : undefined,
      createdAt: dateFromUnixSeconds(sub.created),
      raw: sub,
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

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
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
