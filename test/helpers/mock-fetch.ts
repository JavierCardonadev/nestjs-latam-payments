import type { FetchLike } from '../../src/core/http.js';

export interface MockRoute {
  method?: string;
  url: string | RegExp;
  status?: number;
  body?: unknown;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  json(): any;
  form(): URLSearchParams;
}

/** Minimal fetch double: matches routes in order and records every call. */
export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = new URL(input);
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({
      method,
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body,
      json: () => (body ? JSON.parse(body) : undefined),
      form: () => new URLSearchParams(body ?? ''),
    });
    const route = routes.find(
      (r) =>
        (!r.method || r.method === method) &&
        (typeof r.url === 'string' ? `${url.origin}${url.pathname}` === r.url : r.url.test(url.toString())),
    );
    if (!route) return new Response(JSON.stringify({ message: `no mock for ${method} ${url}` }), { status: 599 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}
