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
import { normalizePlan } from '../../core/subscriptions.js';
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
  ProviderEnvironment,
  Refund,
  RefundRequest,
  Subscription,
  SubscriptionRequest,
  SubscriptionSession,
  SubscriptionStatus,
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

const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  APPROVAL_PENDING: 'pending',
  APPROVED: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'paused',
  CANCELLED: 'canceled',
  EXPIRED: 'expired',
};

const SUBSCRIPTION_EVENTS: Record<string, PaymentEventType> = {
  'BILLING.SUBSCRIPTION.CREATED': 'subscription.pending',
  'BILLING.SUBSCRIPTION.ACTIVATED': 'subscription.activated',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'subscription.activated',
  'BILLING.SUBSCRIPTION.UPDATED': 'subscription.updated',
  'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription.paused',
  'BILLING.SUBSCRIPTION.CANCELLED': 'subscription.canceled',
  'BILLING.SUBSCRIPTION.EXPIRED': 'subscription.expired',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'subscription.payment_failed',
};

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
    subscriptions: true,
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
    const base = {
      provider: this.name,
      id: String(event?.id),
      providerType: eventType,
      occurredAt: dateFromIso(event?.create_time),
      raw: event,
    };

    if (eventType.startsWith('BILLING.SUBSCRIPTION.')) {
      const subscription = this.toSubscription(resource);
      return {
        ...base,
        type: SUBSCRIPTION_EVENTS[eventType] ?? 'unknown',
        subscriptionId: subscription.id,
        reference: subscription.reference,
        amount: subscription.amount,
        currency: subscription.currency,
        subscription,
      };
    }

    // Recurring charges of a subscription are reported as sales tied to its billing agreement.
    if (eventType.startsWith('PAYMENT.SALE.') && resource.billing_agreement_id) {
      const currency: string | undefined = resource.amount?.currency;
      const types: Record<string, PaymentEventType> = {
        'PAYMENT.SALE.COMPLETED': 'subscription.payment_succeeded',
        'PAYMENT.SALE.DENIED': 'subscription.payment_failed',
      };
      return {
        ...base,
        type: types[eventType] ?? 'unknown',
        paymentId: resource.id,
        subscriptionId: resource.billing_agreement_id,
        reference: resource.custom || undefined,
        amount: resource.amount?.total && currency ? toMinorUnits(resource.amount.total, currency) : undefined,
        currency,
      };
    }

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
      ...base,
      type,
      paymentId: isOrder ? resource.id : resource.supplementary_data?.related_ids?.order_id,
      reference: isOrder ? (unit?.custom_id ?? unit?.reference_id) : resource.custom_id,
      status: type === 'unknown' ? undefined : (type.slice('payment.'.length) as PaymentStatus),
      amount: money?.value && currency ? toMinorUnits(money.value, currency) : undefined,
      currency,
    };
  }

  /**
   * Creates a catalog product and a billing plan. Reuse a product with `providerOptions: { productId }`.
   */
  async createPlan(request: PlanRequest): Promise<Plan> {
    const plan = normalizePlan(request);
    const value = this.toValue(plan.amount, plan.currency);
    if (plan.trialDays !== undefined && plan.trialDays > 365) {
      throw new PaymentValidationError('paypal: trialDays must be at most 365');
    }
    const { productId, ...providerOptions } = request.providerOptions ?? {};

    let product = productId as string | undefined;
    if (!product) {
      const { data } = await this.http.request<Record<string, any>>({
        method: 'POST',
        url: `${this.baseUrl}/v1/catalogs/products`,
        headers: await this.authHeaders(request.idempotencyKey && `${request.idempotencyKey}-product`),
        json: { name: plan.name.slice(0, 127), description: plan.description?.slice(0, 256), type: 'SERVICE' },
      });
      product = data.id as string;
    }

    const cycles: Array<Record<string, unknown>> = [];
    if (plan.trialDays) {
      cycles.push({
        frequency: { interval_unit: 'DAY', interval_count: plan.trialDays },
        tenure_type: 'TRIAL',
        sequence: 1,
        total_cycles: 1,
      });
    }
    cycles.push({
      frequency: { interval_unit: plan.interval.toUpperCase(), interval_count: plan.intervalCount },
      tenure_type: 'REGULAR',
      sequence: cycles.length + 1,
      total_cycles: plan.totalCycles ?? 0,
      pricing_scheme: { fixed_price: { value, currency_code: plan.currency } },
    });

    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/billing/plans`,
      headers: await this.authHeaders(request.idempotencyKey),
      json: {
        product_id: product,
        name: plan.name.slice(0, 127),
        description: plan.description?.slice(0, 127),
        status: 'ACTIVE',
        billing_cycles: cycles,
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
        ...providerOptions,
      },
    });
    return this.toPlan(data);
  }

  async getPlan(planId: string): Promise<Plan> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v1/billing/plans/${encodeURIComponent(requireNonEmpty(planId, 'planId'))}`,
      headers: await this.authHeaders(),
    });
    return this.toPlan(data);
  }

  /** Requires a plan id (`createPlan` or the PayPal dashboard): PayPal has no inline plans. */
  async createSubscription(request: SubscriptionRequest): Promise<SubscriptionSession> {
    const reference = requireNonEmpty(request.reference, 'reference');
    if (reference.length > 127) throw new PaymentValidationError('paypal: reference must be at most 127 characters');
    if (typeof request.plan !== 'string') {
      throw new PaymentValidationError('paypal: subscriptions need a plan id; create one with createPlan()');
    }

    const [givenName, ...surname] = (request.customer?.name ?? '').trim().split(/\s+/);
    const { data } = await this.http.request<Record<string, any>>({
      method: 'POST',
      url: `${this.baseUrl}/v1/billing/subscriptions`,
      headers: await this.authHeaders(request.idempotencyKey),
      json: {
        plan_id: requireNonEmpty(request.plan, 'plan'),
        custom_id: reference,
        subscriber: request.customer
          ? {
              email_address: request.customer.email,
              name: givenName ? { given_name: givenName, surname: surname.join(' ') || undefined } : undefined,
            }
          : undefined,
        application_context: {
          brand_name: this.config.brandName,
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: request.successUrl,
          cancel_url: request.cancelUrl,
        },
        ...request.providerOptions,
      },
    });
    const links: Array<{ rel: string; href: string }> = data.links ?? [];
    return {
      provider: this.name,
      id: data.id,
      reference,
      url: links.find((link) => link.rel === 'approve')?.href,
      raw: data,
    };
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const { data } = await this.http.request<Record<string, any>>({
      method: 'GET',
      url: `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(requireNonEmpty(subscriptionId, 'subscriptionId'))}`,
      headers: await this.authHeaders(),
    });
    return this.toSubscription(data);
  }

  async findSubscriptionByReference(): Promise<Subscription | null> {
    throw new UnsupportedOperationError(
      this.name,
      'findSubscriptionByReference',
      'PayPal has no subscription search API; store the subscription id',
    );
  }

  async cancelSubscription(request: CancelSubscriptionRequest): Promise<Subscription> {
    if (request.atPeriodEnd) {
      throw new UnsupportedOperationError(this.name, 'cancel at period end', 'PayPal cancels immediately');
    }
    return this.subscriptionAction(request.subscriptionId, 'cancel', request.reason ?? 'Canceled by the merchant');
  }

  async pauseSubscription(subscriptionId: string): Promise<Subscription> {
    return this.subscriptionAction(subscriptionId, 'suspend', 'Paused by the merchant');
  }

  async resumeSubscription(subscriptionId: string): Promise<Subscription> {
    return this.subscriptionAction(subscriptionId, 'activate', 'Resumed by the merchant');
  }

  /** These endpoints answer 204 without a body, so the subscription is read back afterwards. */
  private async subscriptionAction(subscriptionId: string, action: string, reason: string): Promise<Subscription> {
    const id = requireNonEmpty(subscriptionId, 'subscriptionId');
    await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(id)}/${action}`,
      headers: await this.authHeaders(),
      json: { reason: reason.slice(0, 128) },
    });
    return this.getSubscription(id);
  }

  private toPlan(data: Record<string, any>): Plan {
    const cycles: any[] = data.billing_cycles ?? [];
    const regular = cycles.find((cycle) => cycle.tenure_type === 'REGULAR');
    const trial = cycles.find((cycle) => cycle.tenure_type === 'TRIAL');
    const price = regular?.pricing_scheme?.fixed_price;
    return {
      provider: this.name,
      id: data.id,
      name: data.name,
      amount: price?.value && price.currency_code ? toMinorUnits(price.value, price.currency_code) : undefined,
      currency: price?.currency_code,
      interval: regular?.frequency?.interval_unit?.toLowerCase() as BillingInterval | undefined,
      intervalCount: regular?.frequency?.interval_count,
      trialDays:
        trial?.frequency?.interval_unit === 'DAY'
          ? trial.frequency.interval_count * (trial.total_cycles || 1)
          : undefined,
      totalCycles: regular?.total_cycles || undefined,
      active: data.status === 'ACTIVE',
      raw: data,
    };
  }

  private toSubscription(data: Record<string, any>): Subscription {
    let status = SUBSCRIPTION_STATUS[String(data.status)] ?? 'pending';
    const executions: any[] = data.billing_info?.cycle_executions ?? [];
    if (status === 'active' && executions.some((c) => c.tenure_type === 'TRIAL' && c.cycles_remaining > 0)) {
      status = 'trialing';
    }
    const lastPayment = data.billing_info?.last_payment?.amount;
    const next = dateFromIso(data.billing_info?.next_billing_time);
    return {
      provider: this.name,
      id: data.id,
      reference: data.custom_id || undefined,
      status,
      planId: data.plan_id,
      amount:
        lastPayment?.value && lastPayment.currency_code
          ? toMinorUnits(lastPayment.value, lastPayment.currency_code)
          : undefined,
      currency: lastPayment?.currency_code,
      currentPeriodEnd: status === 'active' || status === 'trialing' ? next : undefined,
      nextBillingAt: status === 'active' || status === 'trialing' ? next : undefined,
      canceledAt: status === 'canceled' ? dateFromIso(data.status_update_time) : undefined,
      customerEmail: data.subscriber?.email_address,
      createdAt: dateFromIso(data.create_time),
      raw: data,
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
