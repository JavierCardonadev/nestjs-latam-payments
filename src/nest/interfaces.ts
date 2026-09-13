import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from '@nestjs/common';
import type { HttpClientOptions } from '../core/http.js';
import type { PaymentProvider } from '../core/provider.js';
import type { MercadoPagoConfig } from '../providers/mercadopago/mercadopago.provider.js';
import type { PayPalConfig } from '../providers/paypal/paypal.provider.js';
import type { PayUConfig } from '../providers/payu/payu.provider.js';
import type { StripeConfig } from '../providers/stripe/stripe.provider.js';
import type { WompiConfig } from '../providers/wompi/wompi.provider.js';

export interface BuiltInProvidersConfig {
  stripe?: StripeConfig;
  paypal?: PayPalConfig;
  mercadopago?: MercadoPagoConfig;
  wompi?: WompiConfig;
  payu?: PayUConfig;
}

export interface WebhookRouteOptions {
  /** Base path of the webhook controller. Final route: `POST /{path}/:provider`. Default `payments/webhooks`. */
  path?: string;
}

export interface PaymentsModuleOptions {
  /** Only the providers you configure are enabled. */
  providers?: BuiltInProvidersConfig;
  /** Your own adapters implementing `PaymentProvider` (dLocal, Kushki, Conekta...). */
  customProviders?: PaymentProvider[];
  /** Used when no provider name is passed to `PaymentsService` methods. */
  defaultProvider?: string;
  /** Shared fetch/timeout applied to every built-in provider without its own `http`. */
  http?: HttpClientOptions;
}

export interface PaymentsModuleRegistration {
  /** Register the module globally (default: true). */
  isGlobal?: boolean;
  /** Mount the webhook controller. `false` disables it. Default: `{ path: 'payments/webhooks' }`. */
  webhooks?: WebhookRouteOptions | false;
}

export interface PaymentsModuleAsyncOptions extends PaymentsModuleRegistration, Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => PaymentsModuleOptions | Promise<PaymentsModuleOptions>;
}
