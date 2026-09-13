import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentsService, renderCheckoutForm } from '../../src/index.js';

interface CreateCheckoutDto {
  provider?: string;
  /** Minor units: 150000 = 1,500.00 COP. */
  amount: number;
  currency: string;
  email?: string;
}

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly payments: PaymentsService) {}

  /** Returns a URL to redirect the buyer to, or (PayU) a URL that renders the auto-submit form. */
  @Post()
  async create(@Body() dto: CreateCheckoutDto) {
    const reference = `ORDER-${randomUUID()}`;
    const session = await this.payments.createCheckout(
      {
        amount: dto.amount,
        currency: dto.currency,
        reference,
        description: 'Demo order',
        customer: { email: dto.email },
        successUrl: `${PUBLIC_URL}/orders/${reference}`,
        cancelUrl: `${PUBLIC_URL}/cart`,
        // Each provider posts to POST /payments/webhooks/:provider (see README).
        notificationUrl: `${PUBLIC_URL}/payments/webhooks/${dto.provider ?? this.payments.provider().name}`,
        idempotencyKey: reference,
      },
      dto.provider,
    );

    // Persist `reference` + `session.id` on your order here.
    return {
      reference,
      provider: session.provider,
      sessionId: session.id,
      redirectUrl: session.url ?? `${PUBLIC_URL}/checkout/form/${reference}`,
    };
  }

  /** Example of serving PayU's POST form. In a real app, load the stored session. */
  @Get('form/:reference')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async form(@Param('reference') reference: string) {
    const session = await this.payments.createCheckout(
      { amount: 2_000_000, currency: 'COP', reference, description: 'Demo order' },
      'payu',
    );
    return renderCheckoutForm(session.form!);
  }
}
