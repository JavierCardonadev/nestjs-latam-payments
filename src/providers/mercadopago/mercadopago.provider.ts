import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import {
  PaymentsConfigurationError,
  PaymentValidationError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../core/errors.js';
import { getHeader, HttpClient, type HttpClientOptions } from '../../core/http.js';
import { assertMinorUnits, normalizeCurrency, toDecimalString, toMinorUnits } from '../../core/money.js';
import type { PaymentProvider } from '../../core/provider.js';
import { normalizePlan, subscriptionEventForStatus } from '../../core/subscriptions.js';
import type {
  BillingInterval,
  CancelSubscriptionRequest,
  CheckoutRequest,
  InlinePlan,
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

const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  pending: 'pending',
  authorized: 'active',
  paused: 'paused',
  cancelled: 'canceled',
};

// Mercado Pago only bills in days or months.
const FREQUENCY: Record<BillingInterval, { multiplier: number; type: 'days' | 'months' }> = {
  day: { multiplier: 1, type: 'days' },
  week: { multiplier: 7, type: 'days' },
  month: { multiplier: 1, type: 'months' },
  year: { multiplier: 12, type: 'months' },
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
    subscriptions: true,
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
    const hydrate = this.config.hydrateWebhooks !== false && dataId !== undefined;

    const event: PaymentEvent = {
      provider: this.name,
      id: String(body?.id ?? getHeader(request.headers, 'x-request-id') ?? `${topic}:${dataId}`),
      type: 'unknown',
      providerType,
      occurredAt: dateFromIso(body?.date_created),
      raw: body,
    };

    if (topic === 'payment') {
      const payment = hydrate ? await this.getPayment(dataId) : undefined;
      return {
        ...event,
        type: eventTypeForStatus(payment?.status),
        paymentId: dataId,
        reference: payment?.reference,
        status: payment?.status,
        amount: payment?.amount,
        currency: payment?.currency,
        payment,
      };
    }

    if (topic === 'subscription_preapproval') {
      const subscription = hydrate ? await this.getSubscription(dataId) : undefined;
      return {
        ...event,
        type: subscription ? subscriptionEventForStatus(subscription.status) : 'unknown',
        subscriptionId: dataId,
        reference: subscription?.reference,
        amount: subscription?.amount,
        currency: subscription?.currency,
        subscription,
      };
    }

    if (topic === 'subscription_authorized_payment' && hydrate) {
      // One billing cycle of a subscription ("invoice"): its payment tells whether the charge went through.
      const { data: invoice } = await this.http.request<Record<string, any>>({
        method: 'GET',
        url: `${this.baseUrl}/authorized_payments/${encodeURIComponent(dataId)}`,
        headers: this.auth,
      });
      const paymentStatus = invoice.payment?.status;
      const type: PaymentEventType =
        paymentStatus === 'approved'
          ? 'subscription.payment_succeeded'
          : paymentStatus === 'rejected'
            ? 'subscription.payment_failed'
            : 'unknown';
      const currency: string | undefined = invoice.currency_id;
      return {
        ...event,
        type,
        paymentId: invoice.payment?.id !== undefined ? String(invoice.payment.id) : undefined,
        subscriptionId: invoice.preapproval_id,
        reference: invoice.external_reference || undefined,
        amount:
          currency && invoice.transaction_amount !== undefined
            ? toMinorUnits(invoice.transaction_amount, currency)
            : undefined,
        currency,
      };
    }

    return event;
  }

  /** Creates a preapproval plan. Pass `providerOptions: { back_url }` if your account requires one. */
  async createPlan(request: PlanRequest): Promise<Plan> {
    const plan = normalizePlan(request);
    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/preapproval_plan`,
      headers: { ...this.auth, 'X-Idempotency-Key': request.idempotencyKey },
      json: { reason: plan.name, auto_recurring: this.autoRecurring(plan), ...request.providerOptions },
    });
    return this.toPlan(data);
  }

  async getPlan(planId: string): Promise<Plan> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/preapproval_plan/${encodeURIComponent(requireNonEmpty(planId, 'planId'))}`,
      headers: this.auth,
    });
    return this.toPlan(data);
  }

  /**
   * Subscription with pending payment: the customer authorizes it at `url` with the payment method they choose.
   * With a plan id, the plan's price and frequency are copied so the subscription keeps your `reference`.
   */
  async createSubscription(request: SubscriptionRequest): Promise<SubscriptionSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    const email = request.customer?.email;
    if (!email) throw new PaymentValidationError('mercadopago: customer.email is required for subscriptions');
    if (!request.successUrl) throw new PaymentValidationError('mercadopago: successUrl is required (back_url)');

    let reason: string;
    let autoRecurring: Record<string, unknown>;
    if (typeof request.plan === 'string') {
      const plan = (await this.getPlan(request.plan)).raw as Record<string, any>;
      const { frequency, frequency_type, transaction_amount, currency_id, repetitions, free_trial } =
        plan.auto_recurring ?? {};
      reason = plan.reason;
      autoRecurring = { frequency, frequency_type, transaction_amount, currency_id, repetitions, free_trial };
    } else {
      const plan = normalizePlan(request.plan);
      reason = plan.name;
      autoRecurring = this.autoRecurring(plan);
    }

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/preapproval`,
      headers: { ...this.auth, 'X-Idempotency-Key': request.idempotencyKey },
      json: {
        reason,
        external_reference: reference,
        payer_email: email,
        auto_recurring: autoRecurring,
        back_url: request.successUrl,
        status: 'pending',
        ...request.providerOptions,
      },
    });
    return {
      provider: this.name,
      id: String(data.id),
      reference,
      url: (this.config.useSandboxInitPoint && data.sandbox_init_point) || data.init_point,
      raw: data,
    };
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/preapproval/${encodeURIComponent(requireNonEmpty(subscriptionId, 'subscriptionId'))}`,
      headers: this.auth,
    });
    return this.toSubscription(data);
  }

  /** Most recent subscription with this `external_reference`. */
  async findSubscriptionByReference(reference: string): Promise<Subscription | null> {
    const { data } = await this.http.request<{ results?: Array<Record<string, any>> }>({
      method: 'GET',
      url: `${this.baseUrl}/preapproval/search`,
      headers: this.auth,
      query: { external_reference: requireNonEmpty(reference, 'reference') },
    });
    const latest = [...(data.results ?? [])].sort((a, b) =>
      String(b.date_created ?? '').localeCompare(String(a.date_created ?? '')),
    )[0];
    return latest ? this.toSubscription(latest) : null;
  }

  async cancelSubscription(request: CancelSubscriptionRequest): Promise<Subscription> {
    if (request.atPeriodEnd) {
      throw new UnsupportedOperationError(this.name, 'cancel at period end', 'Mercado Pago cancels immediately');
    }
    return this.setSubscriptionStatus(request.subscriptionId, 'cancelled');
  }

  async pauseSubscription(subscriptionId: string): Promise<Subscription> {
    return this.setSubscriptionStatus(subscriptionId, 'paused');
  }

  async resumeSubscription(subscriptionId: string): Promise<Subscription> {
    return this.setSubscriptionStatus(subscriptionId, 'authorized');
  }

  private async setSubscriptionStatus(subscriptionId: string, status: string): Promise<Subscription> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'PUT',
      url: `${this.baseUrl}/preapproval/${encodeURIComponent(requireNonEmpty(subscriptionId, 'subscriptionId'))}`,
      headers: this.auth,
      json: { status },
    });
    return this.toSubscription(data);
  }

  private autoRecurring(plan: InlinePlan & { currency: string; intervalCount: number }): Record<string, unknown> {
    const frequency = FREQUENCY[plan.interval];
    return {
      frequency: plan.intervalCount * frequency.multiplier,
      frequency_type: frequency.type,
      transaction_amount: Number(toDecimalString(plan.amount, plan.currency)),
      currency_id: plan.currency,
      repetitions: plan.totalCycles,
      free_trial: plan.trialDays ? { frequency: plan.trialDays, frequency_type: 'days' } : undefined,
    };
  }

  private recurrence(auto: Record<string, any> | undefined) {
    const currency: string | undefined = auto?.currency_id;
    const frequency = Number(auto?.frequency) || undefined;
    let interval: BillingInterval | undefined;
    let intervalCount = frequency;
    if (frequency && auto?.frequency_type === 'months') {
      [interval, intervalCount] = frequency % 12 === 0 ? ['year', frequency / 12] : ['month', frequency];
    } else if (frequency && auto?.frequency_type === 'days') {
      [interval, intervalCount] = frequency % 7 === 0 ? ['week', frequency / 7] : ['day', frequency];
    }
    const trial = auto?.free_trial;
    return {
      amount:
        currency && auto?.transaction_amount !== undefined
          ? toMinorUnits(auto.transaction_amount, currency)
          : undefined,
      currency,
      interval,
      intervalCount: interval ? intervalCount : undefined,
      trialDays:
        trial?.frequency_type === 'days'
          ? Number(trial.frequency)
          : trial?.frequency_type === 'months'
            ? Number(trial.frequency) * 30
            : undefined,
    };
  }

  private toPlan(data: Record<string, any>): Plan {
    const { amount, currency, interval, intervalCount, trialDays } = this.recurrence(data.auto_recurring);
    return {
      provider: this.name,
      id: String(data.id),
      name: data.reason,
      amount,
      currency,
      interval,
      intervalCount,
      trialDays,
      totalCycles: data.auto_recurring?.repetitions ?? undefined,
      active: data.status === 'active',
      raw: data,
    };
  }

  private toSubscription(data: Record<string, any>): Subscription {
    const { amount, currency, interval, intervalCount } = this.recurrence(data.auto_recurring);
    const status = SUBSCRIPTION_STATUS[String(data.status)] ?? 'pending';
    return {
      provider: this.name,
      id: String(data.id),
      reference: data.external_reference || undefined,
      status,
      planId: data.preapproval_plan_id || undefined,
      amount,
      currency,
      interval,
      intervalCount,
      nextBillingAt: status === 'active' ? dateFromIso(data.next_payment_date) : undefined,
      canceledAt: status === 'canceled' ? dateFromIso(data.last_modified) : undefined,
      customerEmail: data.payer_email || undefined,
      createdAt: dateFromIso(data.date_created),
      raw: data,
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
