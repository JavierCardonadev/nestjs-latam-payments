import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  type Type,
} from '@nestjs/common';
import { WebhookVerificationError } from '../core/errors.js';
import { PaymentsService } from './payments.service.js';

/** Creates the webhook controller bound to the configured path. */
export function createPaymentsWebhookController(path: string): Type<unknown> {
  @Controller(path)
  class PaymentsWebhookController {
    private readonly logger = new Logger('PaymentsWebhook');

    constructor(private readonly payments: PaymentsService) {}

    @Post(':provider')
    @HttpCode(200)
    async receive(
      @Param('provider') provider: string,
      @Req() req: { rawBody?: Buffer },
      @Headers() headers: Record<string, string | string[] | undefined>,
      @Query() query: Record<string, unknown>,
      @Body() body: unknown,
    ) {
      if (!this.payments.has(provider)) {
        throw new NotFoundException(`payment provider "${provider}" is not configured`);
      }
      if (!req.rawBody) {
        this.logger.error('rawBody is missing: create the app with NestFactory.create(AppModule, { rawBody: true })');
        throw new InternalServerErrorException('webhook raw body unavailable');
      }

      try {
        const event = await this.payments.handleWebhook(provider, { headers, rawBody: req.rawBody, body, query });
        return { received: true, id: event.id, type: event.type };
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          this.logger.warn(error.message);
          throw new BadRequestException('invalid webhook signature');
        }
        throw error;
      }
    }
  }

  return PaymentsWebhookController;
}
