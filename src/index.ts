export * from './core/types.js';
export type { PaymentProvider } from './core/provider.js';
export * from './core/errors.js';
export { HttpClient, getHeader, type FetchLike, type HttpClientOptions } from './core/http.js';
export { currencyDecimals, toDecimalString, toMinorUnits } from './core/money.js';
export { renderCheckoutForm } from './core/utils.js';
export { normalizePlan, subscriptionEventForStatus } from './core/subscriptions.js';
// Building blocks for custom providers.
export { hashHex, hmacSha256Hex, safeEqual, type HashAlgorithm } from './core/crypto.js';

export { StripeProvider, type StripeConfig } from './providers/stripe/stripe.provider.js';
export { PayPalProvider, PAYPAL_CURRENCIES, type PayPalConfig } from './providers/paypal/paypal.provider.js';
export { MercadoPagoProvider, type MercadoPagoConfig } from './providers/mercadopago/mercadopago.provider.js';
export { WompiProvider, type WompiConfig } from './providers/wompi/wompi.provider.js';
export { PayUProvider, type PayUConfig } from './providers/payu/payu.provider.js';

export { createProviderRegistry, type ProviderRegistry } from './registry.js';

export { PaymentsModule } from './nest/payments.module.js';
export { PaymentsService } from './nest/payments.service.js';
export { PaymentEventsService, OnPaymentEvent } from './nest/payment-events.service.js';
export { PAYMENTS_REGISTRY, PAYMENTS_OPTIONS } from './nest/constants.js';
export type {
  PaymentsModuleOptions,
  PaymentsModuleAsyncOptions,
  PaymentsModuleRegistration,
  BuiltInProvidersConfig,
} from './nest/interfaces.js';
