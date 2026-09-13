import { PaymentsConfigurationError } from './core/errors.js';
import type { PaymentProvider } from './core/provider.js';
import type { PaymentsModuleOptions } from './nest/interfaces.js';
import { MercadoPagoProvider } from './providers/mercadopago/mercadopago.provider.js';
import { PayPalProvider } from './providers/paypal/paypal.provider.js';
import { PayUProvider } from './providers/payu/payu.provider.js';
import { StripeProvider } from './providers/stripe/stripe.provider.js';
import { WompiProvider } from './providers/wompi/wompi.provider.js';

export type ProviderRegistry = Map<string, PaymentProvider>;

/** Builds the provider registry. Usable without NestJS (Express, Fastify, workers). */
export function createProviderRegistry(options: PaymentsModuleOptions): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  const { providers = {}, http } = options;
  const withHttp = <T extends { http?: unknown }>(config: T): T => ({ ...config, http: config.http ?? http });

  if (providers.stripe) registry.set('stripe', new StripeProvider(withHttp(providers.stripe)));
  if (providers.paypal) registry.set('paypal', new PayPalProvider(withHttp(providers.paypal)));
  if (providers.mercadopago) registry.set('mercadopago', new MercadoPagoProvider(withHttp(providers.mercadopago)));
  if (providers.wompi) registry.set('wompi', new WompiProvider(withHttp(providers.wompi)));
  if (providers.payu) registry.set('payu', new PayUProvider(withHttp(providers.payu)));

  for (const provider of options.customProviders ?? []) {
    if (registry.has(provider.name)) {
      throw new PaymentsConfigurationError(`duplicate payment provider name "${provider.name}"`);
    }
    registry.set(provider.name, provider);
  }

  if (registry.size === 0) {
    throw new PaymentsConfigurationError('no payment providers configured');
  }
  if (options.defaultProvider && !registry.has(options.defaultProvider)) {
    throw new PaymentsConfigurationError(`defaultProvider "${options.defaultProvider}" is not configured`);
  }
  return registry;
}
