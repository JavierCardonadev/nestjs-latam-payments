# nestjs-latam-payments

[![CI](https://github.com/JavierCardonadev/nestjs-latam-payments/actions/workflows/ci.yml/badge.svg)](https://github.com/JavierCardonadev/nestjs-latam-payments/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nestjs-latam-payments.svg)](https://www.npmjs.com/package/nestjs-latam-payments)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

**Un solo módulo de NestJS para Wompi, Mercado Pago, PayU LATAM, Stripe y PayPal.**
Crea checkouts, verifica webhooks, consulta y reembolsa pagos con una API normalizada, con la verificación de firmas probada contra los vectores de prueba oficiales de cada pasarela.

> 🇺🇸 [Read in English](README.md)

```ts
@OnPaymentEvent('payment.succeeded')
async marcarPagado(event: PaymentEvent) {
  await this.orders.markPaid(event.reference, event.amount, event.currency);
}
```

## ¿Por qué?

Vender en Latinoamérica casi siempre implica integrar dos o tres pasarelas: una local (Wompi en Colombia, Mercado Pago en Argentina/México/Brasil, PayU en toda la región) y Stripe o PayPal para tarjetas internacionales. Cada una firma los webhooks distinto, usa formatos de monto y nombres de estado diferentes, y tiene sus trampas. Este módulo lo esconde todo detrás de una sola interfaz.

- **Un solo modelo**: montos en enteros de unidad mínima (centavos) + moneda ISO 4217, 9 estados normalizados, 8 tipos de evento del ciclo de vida.
- **Webhooks bien hechos**: verificación HMAC / RSA sobre el cuerpo crudo, comparación en tiempo constante, tolerancia contra replays y nunca se confía en estados que no vienen firmados.
- **Cero dependencias en runtime**: `fetch` nativo y `node:crypto`. Sin SDKs de las pasarelas.
- **NestJS 11 y 12**, o usa los adaptadores sueltos en Express, Fastify o workers.
- **Extensible**: implementa `PaymentProvider` para agregar cualquier pasarela.

## Pasarelas

| Pasarela         | Países               | Checkout                       | Verificación de webhook                  | Consultar | Buscar por referencia | Reembolso      | Reembolso parcial |
| ---------------- | -------------------- | ------------------------------ | ---------------------------------------- | --------- | --------------------- | -------------- | ----------------- |
| **Wompi**        | 🇨🇴                   | Web Checkout (redirección)     | Checksum SHA-256 + firma de integridad   | ✅        | —                     | ✅ (anulación) | —                 |
| **Mercado Pago** | 🇦🇷 🇧🇷 🇲🇽 🇨🇴 🇨🇱 🇵🇪 🇺🇾 | Checkout Pro                   | HMAC `x-signature` + reconsulta a la API | ✅        | ✅                    | ✅             | ✅                |
| **PayU LATAM**   | 🇨🇴 🇲🇽 🇦🇷 🇧🇷 🇨🇱 🇵🇪 🇵🇦 | WebCheckout (formulario POST)  | `sign` MD5 / SHA-1 / SHA-256             | ✅        | ✅                    | ✅             | ✅                |
| **Stripe**       | 🌎 (incl. 🇲🇽 🇧🇷)     | Checkout Sessions              | HMAC `Stripe-Signature` + tolerancia     | ✅        | ✅                    | ✅             | ✅                |
| **PayPal**       | 🌎                   | Orders v2 (aprobar + capturar) | Verificación local con certificado RSA   | ✅        | —                     | ✅             | ✅                |

**Hoja de ruta** (se aceptan contribuciones — ver [issues](https://github.com/JavierCardonadev/nestjs-latam-payments/issues?q=label%3Aprovider)): dLocal, EBANX, Kushki, Conekta, Culqi, OpenPay, ePayco, Transbank Webpay, PagBank.

## Instalación

```bash
npm install nestjs-latam-payments
```

Requiere Node.js ≥ 20.19 y `@nestjs/common` / `@nestjs/core` 11 o 12. El paquete es ESM; las apps Nest en CommonJS pueden cargarlo desde Node 20.19.

## Inicio rápido

### 1. Registra el módulo

```ts
import { Module } from '@nestjs/common';
import { PaymentsModule } from 'nestjs-latam-payments';

@Module({
  imports: [
    PaymentsModule.forRoot({
      defaultProvider: 'wompi',
      providers: {
        wompi: {
          publicKey: process.env.WOMPI_PUBLIC_KEY!,
          privateKey: process.env.WOMPI_PRIVATE_KEY!,
          integritySecret: process.env.WOMPI_INTEGRITY_SECRET!,
          eventsSecret: process.env.WOMPI_EVENTS_SECRET!,
        },
        stripe: {
          secretKey: process.env.STRIPE_SECRET_KEY!,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        },
      },
    }),
  ],
})
export class AppModule {}
```

Con `ConfigService`:

```ts
PaymentsModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: {
      mercadopago: {
        accessToken: config.getOrThrow('MP_ACCESS_TOKEN'),
        webhookSecret: config.get('MP_WEBHOOK_SECRET'),
      },
    },
  }),
});
```

### 2. Habilita el raw body

Las firmas de los webhooks se calculan sobre los bytes exactos que envía la pasarela, así que Nest debe conservarlos:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

### 3. Crea un checkout

```ts
@Controller('orders')
export class OrdersController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/pay')
  async pay(@Param('id') id: string) {
    const session = await this.payments.createCheckout({
      amount: 15_000_000, // 150.000,00 COP — siempre en centavos
      currency: 'COP',
      reference: id, // tu id de orden; vuelve en cada evento
      description: 'Orden #' + id,
      customer: { email: 'comprador@example.com' },
      successUrl: 'https://tienda.example.com/orders/' + id,
    });

    return session.url
      ? { redirectUrl: session.url } // Wompi, Mercado Pago, Stripe, PayPal
      : { form: session.form }; // PayU: renderízalo con renderCheckoutForm(session.form)
  }
}
```

Elige la pasarela por llamada: `createCheckout(request, 'paypal')`.

### 4. Reacciona a los eventos

El módulo monta `POST /payments/webhooks/:provider`. Cada petición se verifica, se normaliza y se despacha a tus handlers:

```ts
@Injectable()
export class PaymentListener {
  @OnPaymentEvent('payment.succeeded')
  async marcarPagado(event: PaymentEvent) {
    // event.provider, event.reference, event.amount (centavos), event.currency, event.payment, event.raw
  }

  @OnPaymentEvent(['payment.failed', 'payment.expired'])
  async liberarInventario(event: PaymentEvent) {}
}
```

- Firma inválida → **400** (el evento se descarta).
- Un handler lanza error → **500**, para que la pasarela reintente. Haz tus handlers idempotentes usando `event.id`.
- Pasarela no configurada → **404**.

¿Prefieres RxJS? `paymentEvents.events$.subscribe(...)`.

## URLs de webhook

| Pasarela     | URL a configurar                               | Dónde                                                                                                             |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Wompi        | `https://tu.app/payments/webhooks/wompi`       | Dashboard → Desarrolladores → URL de eventos                                                                      |
| Mercado Pago | `https://tu.app/payments/webhooks/mercadopago` | Tus integraciones → Webhooks (evento: Pagos). También se envía como `notification_url` si pasas `notificationUrl` |
| PayU         | `https://tu.app/payments/webhooks/payu`        | Se envía por transacción como `confirmationUrl` — pasa `notificationUrl`                                          |
| Stripe       | `https://tu.app/payments/webhooks/stripe`      | Developers → Webhooks. Eventos: `checkout.session.*`, `payment_intent.*`, `charge.refunded`                       |
| PayPal       | `https://tu.app/payments/webhooks/paypal`      | App → Webhooks. Eventos: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*`                                           |

Cambia la ruta base con `PaymentsModule.forRoot({ ...options, webhooks: { path: 'hooks/pay' } })`, o desactiva el controlador con `{ webhooks: false }` y llama tú mismo a `payments.handleWebhook(provider, { headers, rawBody })`.

## Modelo normalizado

**Estados**: `pending`, `requires_action`, `authorized`, `succeeded`, `failed`, `canceled`, `expired`, `refunded`, `partially_refunded`.

**Eventos**: `payment.pending`, `payment.authorized`, `payment.succeeded`, `payment.failed`, `payment.canceled`, `payment.expired`, `payment.refunded`, `payment.partially_refunded`, y `unknown` para eventos de la pasarela fuera del ciclo de pago (siempre disponibles en `event.providerType` / `event.raw`).

**Dinero**: enteros en la unidad mínima de la moneda. `toMinorUnits('150000.50', 'COP')` → `15000050`; `toDecimalString(15000050, 'COP')` → `'150000.50'`. Soporta monedas sin decimales (CLP, JPY…) y de tres decimales (KWD…).

## API

```ts
payments.createCheckout(request, provider?)       // CheckoutSession { id, url?, form?, raw }
payments.getPayment(provider, paymentId)          // Payment
payments.findByReference(provider, reference)     // Payment | null
payments.refund(provider, { paymentId, amount?, reason? })
payments.capture('paypal', orderId)
payments.provider('stripe')                       // el adaptador directo
```

Los errores extienden `PaymentsError`: `ProviderError` (fallos HTTP/API, con `httpStatus`, `code`, `raw`), `WebhookVerificationError`, `UnsupportedOperationError`, `PaymentValidationError`, `PaymentsConfigurationError`.

### Sin NestJS

```ts
import { WompiProvider } from 'nestjs-latam-payments';

const wompi = new WompiProvider({ publicKey, privateKey, integritySecret, eventsSecret });
const session = await wompi.createCheckout({ amount: 5_000_000, currency: 'COP', reference: 'A-1' });

app.post('/webhooks/wompi', express.raw({ type: '*/*' }), async (req, res) => {
  const event = await wompi.parseWebhook({ headers: req.headers, rawBody: req.body });
  res.sendStatus(200);
});
```

## Notas por pasarela

- **Wompi** solo liquida en COP; los reembolsos son anulaciones totales (pagos con tarjeta). Sandbox o producción se infiere del prefijo de la llave y se rechaza si no coincide.
- **Mercado Pago** no envía el estado en la notificación, así que el pago se reconsulta en la API (`hydrateWebhooks: true` por defecto). Configura `webhookSecret` para verificar `x-signature`.
- **PayU** WebCheckout es un formulario HTML por POST; `renderCheckoutForm(session.form)` devuelve una página que se envía sola. La firma de confirmación se verifica con el algoritmo que usó PayU.
- **Stripe** exige `successUrl`. `reference` se guarda como `client_reference_id` y en metadata, así `findByReference` funciona con la Search API.
- **PayPal** captura automáticamente cuando llega el webhook `CHECKOUT.ORDER.APPROVED` (`autoCaptureOnApproval: false` para desactivarlo). Los webhooks se verifican localmente con el certificado de PayPal; se rechazan certificados fuera de `api(-m)(.sandbox).paypal.com`.

Más detalle en [docs/providers.md](docs/providers.md) (inglés).

## Agregar una pasarela

Implementa la interfaz `PaymentProvider` y pásala en `customProviders`. La guía está en [docs/adding-a-provider.md](docs/adding-a-provider.md) — los PRs para las pasarelas de la hoja de ruta son muy bienvenidos.

## Desarrollo

```bash
npm install
npm test          # unitarias + e2e (sin red)
npm run test:live # usa el sandbox público de PayU
npm run lint && npm run typecheck && npm run build
```

Hay un ejemplo ejecutable en [examples/nest-app](examples/nest-app).

## ¿Necesitas ayuda integrando pagos en Latinoamérica?

Soy Javier Cardona, desarrollador full-stack en Colombia y autor de este módulo. Ayudo a empresas a lanzar y corregir sus flujos de pago: elección de pasarela, checkout, webhooks y conciliación, suscripciones, operación multi-país y migraciones entre pasarelas.

👉 **[javiercardona.dev](https://javiercardona.dev)** — o abre un [issue de ayuda con integración](https://github.com/JavierCardonadev/nestjs-latam-payments/issues/new?template=integration-help.yml).

## Licencia

[MIT](LICENSE) © Javier Cardona. Sin afiliación con ninguna de las pasarelas mencionadas.
