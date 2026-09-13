import { ProviderError } from './errors.js';
import type { HeaderValue } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Inject a custom fetch (proxies, tracing, tests). Defaults to global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, string | number | undefined>;
  /** JSON body. */
  json?: unknown;
  /** application/x-www-form-urlencoded body (Stripe, OAuth). */
  form?: URLSearchParams;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly provider: string,
    options: HttpClientOptions = {},
  ) {
    const impl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!impl) {
      throw new ProviderError(provider, 'global fetch is unavailable; use Node.js >= 18.18 or pass `fetch`');
    }
    this.fetchImpl = impl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(req.url);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (value !== undefined) headers[key] = value;
    }

    let body: string | undefined;
    if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = req.form.toString();
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new ProviderError(this.provider, `network error calling ${req.method} ${url.pathname}`, { cause });
    }

    const text = await response.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON body (HTML error pages, plain text); keep it as a string.
      }
    } else {
      data = undefined;
    }

    if (!response.ok) {
      throw new ProviderError(this.provider, `${req.method} ${url.pathname} failed with HTTP ${response.status}`, {
        httpStatus: response.status,
        code: extractErrorCode(data),
        raw: data,
      });
    }

    return { status: response.status, headers: response.headers, data: data as T };
  }
}

function extractErrorCode(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, any>;
  const code =
    record.error?.code ?? record.error?.type ?? record.name ?? record.code ?? record.error ?? record.cause?.[0]?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

/** Case-insensitive header lookup; returns the first value. */
export function getHeader(headers: Record<string, HeaderValue> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === 'string' ? first : undefined;
    }
  }
  return undefined;
}

export function rawBodyToString(rawBody: Buffer | string | undefined): string {
  if (rawBody === undefined || rawBody === null) return '';
  return typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
}
