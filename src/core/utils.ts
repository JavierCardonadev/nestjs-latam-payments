import { PaymentsConfigurationError, PaymentValidationError, WebhookVerificationError } from './errors.js';
import { rawBodyToString } from './http.js';
import type { CheckoutForm, PaymentEventType, PaymentStatus, WebhookRequest } from './types.js';

export function eventTypeForStatus(status: PaymentStatus | undefined): PaymentEventType {
  if (!status) return 'unknown';
  return status === 'requires_action' ? 'payment.pending' : (`payment.${status}` as PaymentEventType);
}

export function requireConfig<T extends object>(provider: string, config: T | undefined, keys: Array<keyof T>): T {
  if (!config) throw new PaymentsConfigurationError(`${provider}: missing configuration`);
  const missing = keys.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length) {
    throw new PaymentsConfigurationError(`${provider}: missing required option(s): ${missing.map(String).join(', ')}`);
  }
  return config;
}

export function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PaymentValidationError(`${field} is required`);
  }
  return value;
}

/** Reads `a.b.c` from an object; returns undefined on any missing segment. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Parses the JSON webhook body from the raw bytes (never trust a re-serialized body). */
export function parseJsonWebhook(provider: string, request: WebhookRequest): any {
  const text = rawBodyToString(request.rawBody);
  if (!text) {
    if (request.body && typeof request.body === 'object') return request.body;
    throw new WebhookVerificationError(provider, 'empty body');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WebhookVerificationError(provider, 'body is not valid JSON');
  }
}

/** Parses an application/x-www-form-urlencoded webhook body (PayU). */
export function parseFormWebhook(provider: string, request: WebhookRequest): Record<string, string> {
  const text = rawBodyToString(request.rawBody);
  if (text) return Object.fromEntries(new URLSearchParams(text));
  if (request.body && typeof request.body === 'object') {
    return Object.fromEntries(
      Object.entries(request.body as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]),
    );
  }
  throw new WebhookVerificationError(provider, 'empty body');
}

export function dateFromUnixSeconds(value: unknown): Date | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

export function dateFromIso(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function queryValue(query: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = query?.[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? undefined : String(first);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a self-submitting HTML page for providers that require a POST form
 * (PayU WebCheckout). Serve it with `Content-Type: text/html`.
 */
export function renderCheckoutForm(form: CheckoutForm, { title = 'Redirecting to payment…' } = {}): string {
  const inputs = Object.entries(form.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n      ');
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body>
    <form id="checkout" method="${form.method}" action="${escapeHtml(form.action)}">
      ${inputs}
      <noscript><button type="submit">Continue to payment</button></noscript>
    </form>
    <script>document.getElementById('checkout').submit();</script>
  </body>
</html>`;
}
