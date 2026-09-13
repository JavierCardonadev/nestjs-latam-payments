/**
 * Normalized payment model shared by every provider adapter.
 *
 * Money is always expressed as an integer amount of **minor units** (cents)
 * plus an ISO 4217 currency code. Adapters convert to whatever each provider
 * expects (Stripe/Wompi: minor units, PayPal/Mercado Pago/PayU: decimal).
 */

export type ProviderName = 'stripe' | 'paypal' | 'mercadopago' | 'wompi' | 'payu' | (string & {});

export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

export type PaymentEventType =
  | 'payment.pending'
  | 'payment.authorized'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.canceled'
  | 'payment.expired'
  | 'payment.refunded'
  | 'payment.partially_refunded'
  | SubscriptionEventType
  | 'unknown';

export type SubscriptionEventType =
  /** Created, waiting for the customer to authorize it. */
  | 'subscription.pending'
  /** Authorized: active or trialing (also sent when it becomes active again). */
  | 'subscription.activated'
  /** Any other change (plan, quantity, billing dates…). */
  | 'subscription.updated'
  | 'subscription.past_due'
  | 'subscription.paused'
  | 'subscription.canceled'
  | 'subscription.expired'
  /** A recurring charge was collected. */
  | 'subscription.payment_succeeded'
  /** A recurring charge failed; the provider may retry. */
  | 'subscription.payment_failed';

export interface Customer {
  email?: string;
  name?: string;
  phone?: string;
  /** Local ID document type, e.g. CC, CE, NIT (CO), CPF (BR), RFC (MX). */
  documentType?: string;
  documentNumber?: string;
}

export interface CheckoutRequest {
  /** Integer amount in minor units, e.g. 150000 = 1,500.00 COP. */
  amount: number;
  /** ISO 4217 code, e.g. COP, MXN, BRL, USD. */
  currency: string;
  /** Your own unique order identifier. Used to reconcile webhooks. */
  reference: string;
  description?: string;
  customer?: Customer;
  /** Where the buyer lands after paying (or after any final outcome). */
  successUrl?: string;
  /** Where the buyer lands when they abandon or cancel. */
  cancelUrl?: string;
  /** Per-payment webhook URL, for providers that accept one. */
  notificationUrl?: string;
  metadata?: Record<string, string>;
  expiresAt?: Date;
  idempotencyKey?: string;
  /** Escape hatch: raw provider-specific fields merged into the request. */
  providerOptions?: Record<string, unknown>;
}

/** A redirect URL (GET) or an auto-submitted HTML form (POST, e.g. PayU). */
export interface CheckoutForm {
  method: 'GET' | 'POST';
  action: string;
  fields: Record<string, string>;
}

export interface CheckoutSession {
  provider: ProviderName;
  /** Provider session/preference/order id (or your reference when none exists yet). */
  id: string;
  reference: string;
  /** Present when the buyer can be redirected with a plain GET. */
  url?: string;
  /** Present when the provider requires posting a form (PayU WebCheckout). */
  form?: CheckoutForm;
  expiresAt?: Date;
  raw: unknown;
}

export interface Payment {
  provider: ProviderName;
  id: string;
  reference?: string;
  status: PaymentStatus;
  /** Minor units. */
  amount?: number;
  currency?: string;
  /** Minor units already refunded, when the provider reports it. */
  amountRefunded?: number;
  /** Provider payment method label, e.g. CARD, NEQUI, PSE, pix, visa. */
  method?: string;
  createdAt?: Date;
  raw: unknown;
}

export interface RefundRequest {
  paymentId: string;
  /** Minor units. Omit for a full refund. */
  amount?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface Refund {
  provider: ProviderName;
  id: string;
  paymentId: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount?: number;
  currency?: string;
  raw: unknown;
}

export type HeaderValue = string | string[] | undefined;

/** Framework-agnostic view of an incoming webhook HTTP request. */
export interface WebhookRequest {
  headers: Record<string, HeaderValue>;
  /** The exact bytes received. Signatures are computed over these. */
  rawBody: Buffer | string;
  /** Parsed body, if your framework already parsed it (JSON or urlencoded). */
  body?: unknown;
  query?: Record<string, unknown>;
}

export interface PaymentEvent {
  provider: ProviderName;
  /** Provider event id (use it to deduplicate retries). */
  id: string;
  type: PaymentEventType;
  /** Provider-native event name, e.g. `payment_intent.succeeded`. */
  providerType: string;
  paymentId?: string;
  reference?: string;
  status?: PaymentStatus;
  amount?: number;
  currency?: string;
  occurredAt?: Date;
  /** The payment fetched from the provider, when the adapter hydrated it. */
  payment?: Payment;
  /** Set on `subscription.*` events. */
  subscriptionId?: string;
  /** The subscription, when the payload carries it or the adapter hydrated it. */
  subscription?: Subscription;
  raw: unknown;
}

export interface ProviderCapabilities {
  checkout: boolean;
  getPayment: boolean;
  findByReference: boolean;
  refund: boolean;
  partialRefund: boolean;
  capture: boolean;
  webhooks: boolean;
  /** Plans and recurring subscriptions. */
  subscriptions?: boolean;
}

export type ProviderEnvironment = 'sandbox' | 'production';

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export interface PlanRequest {
  name: string;
  description?: string;
  /** Price per billing period in minor units. */
  amount: number;
  currency: string;
  interval: BillingInterval;
  /** Bill every N intervals, e.g. `interval: 'month', intervalCount: 3` for quarterly. Default 1. */
  intervalCount?: number;
  /** Free days before the first charge. */
  trialDays?: number;
  /** Number of charges before the subscription ends. Omit to renew until canceled. */
  totalCycles?: number;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  /** Escape hatch: raw provider-specific fields merged into the request. */
  providerOptions?: Record<string, unknown>;
}

export interface Plan {
  provider: ProviderName;
  /** Use it as `plan` in `createSubscription`. Stripe: price id; Mercado Pago: preapproval plan id; PayPal: plan id. */
  id: string;
  name?: string;
  amount?: number;
  currency?: string;
  interval?: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
  totalCycles?: number;
  active: boolean;
  raw: unknown;
}

export type SubscriptionStatus = 'pending' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'expired';

/** A plan defined in place, for providers that accept it (Stripe, Mercado Pago). */
export type InlinePlan = Omit<PlanRequest, 'idempotencyKey' | 'providerOptions' | 'metadata'>;

export interface SubscriptionRequest {
  /** Your own identifier (account, tenant, order). Comes back on every subscription event. */
  reference: string;
  /** A plan id (from `createPlan` or the provider dashboard) or an inline plan. */
  plan: string | InlinePlan;
  /** Mercado Pago requires `customer.email`. */
  customer?: Customer;
  /** Where the customer lands after authorizing. Required by Stripe and Mercado Pago. */
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  providerOptions?: Record<string, unknown>;
}

/** Redirect the customer to `url` to authorize the subscription. */
export interface SubscriptionSession {
  provider: ProviderName;
  /**
   * Stripe: Checkout Session id (`cs_…`, the subscription is created on completion);
   * Mercado Pago: preapproval id; PayPal: subscription id.
   */
  id: string;
  reference: string;
  url?: string;
  raw: unknown;
}

export interface Subscription {
  provider: ProviderName;
  id: string;
  reference?: string;
  status: SubscriptionStatus;
  planId?: string;
  /** Recurring amount in minor units, when the provider reports it. */
  amount?: number;
  currency?: string;
  interval?: BillingInterval;
  intervalCount?: number;
  /** End of the period already paid for. */
  currentPeriodEnd?: Date;
  nextBillingAt?: Date;
  /** Cancellation is scheduled for the end of the current period. */
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date;
  customerEmail?: string;
  createdAt?: Date;
  raw: unknown;
}

export interface CancelSubscriptionRequest {
  subscriptionId: string;
  /** Keep access until the paid period ends (Stripe only). Default: cancel now. */
  atPeriodEnd?: boolean;
  reason?: string;
}
