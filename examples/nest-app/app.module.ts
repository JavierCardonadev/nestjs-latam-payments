import { Module } from '@nestjs/common';
import { PaymentsModule } from '../../src/index.js';
import { CheckoutController } from './checkout.controller.js';
import { OrdersListener } from './orders.listener.js';

const env = (key: string) => process.env[key];
/** Spreads a provider config only when its env var is present. */
const when = <T extends object>(key: string, config: () => T): Partial<T> => (env(key) ? config() : {});

@Module({
  imports: [
    PaymentsModule.forRoot({
      defaultProvider: env('WOMPI_PUBLIC_KEY') ? 'wompi' : 'payu',
      providers: {
        // Enable only the providers you have credentials for.
        ...when('WOMPI_PUBLIC_KEY', () => ({
          wompi: {
            publicKey: env('WOMPI_PUBLIC_KEY')!,
            privateKey: env('WOMPI_PRIVATE_KEY')!,
            integritySecret: env('WOMPI_INTEGRITY_SECRET')!,
            eventsSecret: env('WOMPI_EVENTS_SECRET')!,
          },
        })),
        ...when('MERCADOPAGO_ACCESS_TOKEN', () => ({
          mercadopago: {
            accessToken: env('MERCADOPAGO_ACCESS_TOKEN')!,
            webhookSecret: env('MERCADOPAGO_WEBHOOK_SECRET'),
          },
        })),
        ...when('STRIPE_SECRET_KEY', () => ({
          stripe: { secretKey: env('STRIPE_SECRET_KEY')!, webhookSecret: env('STRIPE_WEBHOOK_SECRET') },
        })),
        ...when('PAYPAL_CLIENT_ID', () => ({
          paypal: {
            clientId: env('PAYPAL_CLIENT_ID')!,
            clientSecret: env('PAYPAL_CLIENT_SECRET')!,
            webhookId: env('PAYPAL_WEBHOOK_ID'),
            environment: env('PAYPAL_ENVIRONMENT') === 'production' ? ('production' as const) : ('sandbox' as const),
          },
        })),
        // PayU publishes public sandbox credentials, so this one works out of the box.
        payu: {
          apiKey: env('PAYU_API_KEY') ?? '4Vj8eK4rloUd272L48hsrarnUA',
          apiLogin: env('PAYU_API_LOGIN') ?? 'pRRXKOl8ikMmt9u',
          merchantId: env('PAYU_MERCHANT_ID') ?? '508029',
          accountId: env('PAYU_ACCOUNT_ID') ?? '512321',
        },
      },
    }),
  ],
  controllers: [CheckoutController],
  providers: [OrdersListener],
})
export class AppModule {}
