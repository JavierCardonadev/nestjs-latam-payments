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
  | 'unknown';

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
}

export type ProviderEnvironment = 'sandbox' | 'production';
