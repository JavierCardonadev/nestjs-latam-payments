import { Injectable, Logger, SetMetadata, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Subject, type Observable } from 'rxjs';
import type { PaymentEvent, PaymentEventType } from '../core/types.js';
import { PAYMENT_EVENT_HANDLER } from './constants.js';

type EventFilter = PaymentEventType | PaymentEventType[] | '*';
type Handler = (event: PaymentEvent) => unknown | Promise<unknown>;

/**
 * Marks a provider/controller method as a payment event handler.
 *
 * ```ts
 * @OnPaymentEvent('payment.succeeded')
 * async markPaid(event: PaymentEvent) { ... }
 * ```
 * Handlers run before the webhook is acknowledged. If one throws, the webhook
 * answers 500 and the provider retries — so make handlers idempotent (use `event.id`).
 */
export const OnPaymentEvent = (types: EventFilter = '*'): MethodDecorator => SetMetadata(PAYMENT_EVENT_HANDLER, types);

@Injectable()
export class PaymentEventsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentEvents');
  private readonly subject = new Subject<PaymentEvent>();
  private readonly handlers: Array<{ types: Set<string> | '*'; handle: Handler }> = [];

  /** Every verified event, after handlers finished. */
  readonly events$: Observable<PaymentEvent> = this.subject.asObservable();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const wrappers = [...this.discovery.getProviders(), ...this.discovery.getControllers()];
    for (const wrapper of wrappers) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = instance[methodName];
        if (typeof method !== 'function') continue;
        const filter = this.reflector.get<EventFilter | undefined>(PAYMENT_EVENT_HANDLER, method);
        if (filter === undefined) continue;
        this.on(filter, (event) => (method as Handler).call(instance, event));
        this.logger.log(
          `Mapped ${wrapper.name}.${methodName} to ${Array.isArray(filter) ? filter.join(', ') : filter}`,
        );
      }
    }
  }

  /** Programmatic subscription. Returns an unsubscribe function. */
  on(types: EventFilter, handle: Handler): () => void {
    const entry = { types: types === '*' ? ('*' as const) : new Set(Array.isArray(types) ? types : [types]), handle };
    this.handlers.push(entry);
    return () => {
      const index = this.handlers.indexOf(entry);
      if (index !== -1) this.handlers.splice(index, 1);
    };
  }

  async emit(event: PaymentEvent): Promise<void> {
    const matching = this.handlers.filter((h) => h.types === '*' || h.types.has(event.type));
    await Promise.all(matching.map((h) => h.handle(event)));
    this.subject.next(event);
  }
}
