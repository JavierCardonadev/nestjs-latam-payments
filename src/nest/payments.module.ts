import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { createProviderRegistry } from '../registry.js';
import { DEFAULT_WEBHOOK_PATH, PAYMENTS_OPTIONS, PAYMENTS_REGISTRY } from './constants.js';
import type { PaymentsModuleAsyncOptions, PaymentsModuleOptions, PaymentsModuleRegistration } from './interfaces.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentsService } from './payments.service.js';
import { createPaymentsWebhookController } from './webhook.controller.js';

@Module({})
export class PaymentsModule {
  static forRoot(options: PaymentsModuleOptions & PaymentsModuleRegistration): DynamicModule {
    return PaymentsModule.build(options, [{ provide: PAYMENTS_OPTIONS, useValue: options }]);
  }

  static forRootAsync(options: PaymentsModuleAsyncOptions): DynamicModule {
    return PaymentsModule.build(
      options,
      [{ provide: PAYMENTS_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] }],
      options.imports,
    );
  }

  private static build(
    registration: PaymentsModuleRegistration,
    optionProviders: Provider[],
    imports: DynamicModule['imports'] = [],
  ): DynamicModule {
    const webhooks = registration.webhooks === false ? false : { path: DEFAULT_WEBHOOK_PATH, ...registration.webhooks };
    return {
      module: PaymentsModule,
      global: registration.isGlobal ?? true,
      imports: [DiscoveryModule, ...imports],
      controllers: webhooks ? [createPaymentsWebhookController(webhooks.path)] : [],
      providers: [
        ...optionProviders,
        {
          provide: PAYMENTS_REGISTRY,
          useFactory: (resolved: PaymentsModuleOptions) => createProviderRegistry(resolved),
          inject: [PAYMENTS_OPTIONS],
        },
        PaymentEventsService,
        PaymentsService,
      ],
      exports: [PaymentsService, PaymentEventsService, PAYMENTS_REGISTRY],
    };
  }
}
