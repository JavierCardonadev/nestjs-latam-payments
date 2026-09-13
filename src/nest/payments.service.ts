import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentsConfigurationError, UnsupportedOperationError } from '../core/errors.js';
import type { PaymentProvider } from '../core/provider.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  Payment,
  PaymentEvent,
  Refund,
  RefundRequest,
  WebhookRequest,
} from '../core/types.js';
import { PayPalProvider } from '../providers/paypal/paypal.provider.js';
import type { ProviderRegistry } from '../registry.js';
import { PAYMENTS_OPTIONS, PAYMENTS_REGISTRY } from './constants.js';
import type { PaymentsModuleOptions } from './interfaces.js';
import { PaymentEventsService } from './payment-events.service.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('PaymentsService');

  constructor(
    @Inject(PAYMENTS_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(PAYMENTS_OPTIONS) private readonly options: PaymentsModuleOptions,
    private readonly events: PaymentEventsService,
  ) {}

  /** Names of the enabled providers. */
  get providerNames(): string[] {
    return [...this.registry.keys()];
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** Direct access to an adapter, e.g. `payments.provider('wompi')`. */
  provider(name?: string): PaymentProvider {
    const resolved =
      name ?? this.options.defaultProvider ?? (this.registry.size === 1 ? this.providerNames[0] : undefined);
    if (!resolved) {
      throw new PaymentsConfigurationError(
        `specify a provider (${this.providerNames.join(', ')}) or set defaultProvider`,
      );
    }
    const provider = this.registry.get(resolved);
    if (!provider) {
      throw new PaymentsConfigurationError(`payment provider "${resolved}" is not configured`);
    }
    return provider;
  }

  // Methods are async so configuration errors surface as rejections, never synchronous throws.
  async createCheckout(request: CheckoutRequest, provider?: string): Promise<CheckoutSession> {
    return this.provider(provider).createCheckout(request);
  }

  async getPayment(provider: string, paymentId: string): Promise<Payment> {
    return this.provider(provider).getPayment(paymentId);
  }

  async findByReference(provider: string, reference: string): Promise<Payment | null> {
    return this.provider(provider).findByReference(reference);
  }

  async refund(provider: string, request: RefundRequest): Promise<Refund> {
    return this.provider(provider).refund(request);
  }

  async capture(provider: string, paymentId: string): Promise<Payment> {
    const adapter = this.provider(provider);
    if (!adapter.capture) throw new UnsupportedOperationError(adapter.name, 'capture');
    return adapter.capture(paymentId);
  }

  /**
   * Verifies a webhook, runs `@OnPaymentEvent` handlers and returns the event.
   * PayPal approvals are captured automatically unless `autoCaptureOnApproval: false`.
   */
  async handleWebhook(providerName: string, request: WebhookRequest): Promise<PaymentEvent> {
    const adapter = this.provider(providerName);
    const event = await adapter.parseWebhook(request);

    if (
      adapter instanceof PayPalProvider &&
      event.type === 'payment.authorized' &&
      event.paymentId &&
      adapter.autoCaptureOnApproval
    ) {
      event.payment = await adapter.capture(event.paymentId);
      this.logger.log(`Captured PayPal order ${event.paymentId} (${event.payment.status})`);
    }

    await this.events.emit(event);
    return event;
  }
}
