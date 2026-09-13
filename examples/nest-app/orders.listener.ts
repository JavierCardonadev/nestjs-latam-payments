import { Injectable, Logger } from '@nestjs/common';
import { OnPaymentEvent, type PaymentEvent } from '../../src/index.js';

@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);
  /** Replace with a table and a unique index on (provider, event_id). */
  private readonly processed = new Set<string>();

  @OnPaymentEvent('payment.succeeded')
  async markPaid(event: PaymentEvent) {
    const key = `${event.provider}:${event.id}`;
    if (this.processed.has(key)) return; // providers retry; stay idempotent
    this.processed.add(key);
    this.logger.log(`Order ${event.reference} paid via ${event.provider}: ${event.amount} ${event.currency}`);
  }

  @OnPaymentEvent(['payment.failed', 'payment.expired', 'payment.canceled'])
  releaseStock(event: PaymentEvent) {
    this.logger.warn(`Order ${event.reference} not paid (${event.type})`);
  }

  @OnPaymentEvent(['payment.refunded', 'payment.partially_refunded'])
  onRefund(event: PaymentEvent) {
    this.logger.log(`Refund on order ${event.reference} (${event.type})`);
  }
}
