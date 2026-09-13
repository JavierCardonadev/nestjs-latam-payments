export class PaymentsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing module/provider configuration. */
export class PaymentsConfigurationError extends PaymentsError {}

/** The provider can't do what was asked (e.g. partial refunds on Wompi). */
export class UnsupportedOperationError extends PaymentsError {
  constructor(
    readonly provider: string,
    readonly operation: string,
    detail?: string,
  ) {
    super(`${provider} does not support ${operation}${detail ? `: ${detail}` : ''}`);
  }
}

/** Request rejected before reaching the provider (bad amount, currency, ...). */
export class PaymentValidationError extends PaymentsError {}

/** The provider answered with an error. `raw` holds its response body. */
export class ProviderError extends PaymentsError {
  constructor(
    readonly provider: string,
    message: string,
    readonly details: {
      httpStatus?: number;
      code?: string;
      raw?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(`[${provider}] ${message}`, { cause: details.cause });
  }

  get httpStatus(): number | undefined {
    return this.details.httpStatus;
  }

  get code(): string | undefined {
    return this.details.code;
  }

  get raw(): unknown {
    return this.details.raw;
  }
}

/** The webhook could not be proven authentic. Respond with 4xx and ignore it. */
export class WebhookVerificationError extends PaymentsError {
  constructor(
    readonly provider: string,
    readonly reason: string,
  ) {
    super(`[${provider}] webhook verification failed: ${reason}`);
  }
}
