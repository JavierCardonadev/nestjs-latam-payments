import type {
  CancelSubscriptionRequest,
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  Plan,
  PlanRequest,
  ProviderCapabilities,
  Refund,
  RefundRequest,
  Subscription,
  SubscriptionRequest,
  SubscriptionSession,
  WebhookRequest,
} from './types.js';

/**
 * Contract every adapter implements. Implement it to plug in any provider
 * (dLocal, Kushki, Conekta, ...) and register it with
 * `PaymentsModule.forRoot({ customProviders: [...] })`.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  getPayment(paymentId: string): Promise<Payment>;

  /** Latest payment for your own reference, or `null` when none exists. */
  findByReference(reference: string): Promise<Payment | null>;

  refund(request: RefundRequest): Promise<Refund>;

  /** Capture an approved/authorized payment (PayPal orders). */
  capture?(paymentId: string): Promise<Payment>;

  /**
   * Verify the webhook signature and translate it into a normalized event.
   * MUST throw `WebhookVerificationError` when authenticity can't be proven.
   */
  parseWebhook(request: WebhookRequest): Promise<PaymentEvent>;

  // Recurring billing. Implement all of them and set `capabilities.subscriptions`.

  createPlan?(request: PlanRequest): Promise<Plan>;

  getPlan?(planId: string): Promise<Plan>;

  /** Starts a subscription and returns the URL where the customer authorizes it. */
  createSubscription?(request: SubscriptionRequest): Promise<SubscriptionSession>;

  getSubscription?(subscriptionId: string): Promise<Subscription>;

  findSubscriptionByReference?(reference: string): Promise<Subscription | null>;

  cancelSubscription?(request: CancelSubscriptionRequest): Promise<Subscription>;

  pauseSubscription?(subscriptionId: string): Promise<Subscription>;

  resumeSubscription?(subscriptionId: string): Promise<Subscription>;
}
