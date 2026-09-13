import { describe, expect, it } from 'vitest';
import { crc32, safeEqual } from '../../src/core/crypto.js';
import { PaymentValidationError, ProviderError } from '../../src/core/errors.js';
import { getHeader, HttpClient } from '../../src/core/http.js';
import { currencyDecimals, toDecimalString, toMinorUnits } from '../../src/core/money.js';
import { renderCheckoutForm } from '../../src/core/utils.js';
import { mockFetch } from '../helpers/mock-fetch.js';

describe('money', () => {
  it('uses ISO 4217 exponents', () => {
    expect(currencyDecimals('COP')).toBe(2);
    expect(currencyDecimals('clp')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
  });

  it('converts minor units to decimal strings without floating point', () => {
    expect(toDecimalString(150000, 'COP')).toBe('1500.00');
    expect(toDecimalString(5, 'USD')).toBe('0.05');
    expect(toDecimalString(1500, 'CLP')).toBe('1500');
    expect(toDecimalString(1, 'KWD')).toBe('0.001');
  });

  it('parses decimals into minor units', () => {
    expect(toMinorUnits('1500.00', 'COP')).toBe(150000);
    expect(toMinorUnits('0.1', 'USD')).toBe(10);
    expect(toMinorUnits(19.99, 'USD')).toBe(1999);
    expect(toMinorUnits('10.005', 'USD')).toBe(1001);
    expect(toMinorUnits('2000', 'CLP')).toBe(2000);
  });

  it('rejects invalid amounts and currencies', () => {
    expect(() => toDecimalString(0, 'USD')).toThrow(PaymentValidationError);
    expect(() => toDecimalString(10.5, 'USD')).toThrow(PaymentValidationError);
    expect(() => toDecimalString(100, 'US')).toThrow(PaymentValidationError);
    expect(() => toMinorUnits('abc', 'USD')).toThrow(PaymentValidationError);
  });
});

describe('crypto', () => {
  it('computes the standard CRC-32 check value', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('compares in constant time, case-insensitive by default', () => {
    expect(safeEqual('ABCDEF', 'abcdef')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('ABC', 'abc', { ignoreCase: false })).toBe(false);
  });
});

describe('http client', () => {
  it('sends JSON and parses responses', async () => {
    const { fetch, calls } = mockFetch([{ method: 'POST', url: 'https://api.test/items', body: { ok: true } }]);
    const client = new HttpClient('test', { fetch });
    const response = await client.request({
      method: 'POST',
      url: 'https://api.test/items',
      json: { a: 1 },
      query: { q: 'x' },
    });
    expect(response.data).toEqual({ ok: true });
    expect(calls[0]!.json()).toEqual({ a: 1 });
    expect(calls[0]!.url.searchParams.get('q')).toBe('x');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('wraps HTTP errors in ProviderError with the raw body', async () => {
    const { fetch } = mockFetch([
      { url: 'https://api.test/fail', status: 422, body: { error: { code: 'bad_thing' } } },
    ]);
    const client = new HttpClient('test', { fetch });
    const error = await client.request({ method: 'GET', url: 'https://api.test/fail' }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.httpStatus).toBe(422);
    expect(error.code).toBe('bad_thing');
    expect(error.raw).toEqual({ error: { code: 'bad_thing' } });
  });

  it('wraps network failures', async () => {
    const client = new HttpClient('test', {
      fetch: async () => {
        throw new TypeError('socket hang up');
      },
    });
    await expect(client.request({ method: 'GET', url: 'https://api.test/x' })).rejects.toThrow(/network error/);
  });

  it('reads headers case-insensitively', () => {
    expect(getHeader({ 'X-Event-Checksum': 'abc' }, 'x-event-checksum')).toBe('abc');
    expect(getHeader({ 'stripe-signature': ['a', 'b'] }, 'Stripe-Signature')).toBe('a');
    expect(getHeader({}, 'missing')).toBeUndefined();
  });
});

describe('renderCheckoutForm', () => {
  it('escapes values and auto-submits', () => {
    const html = renderCheckoutForm({
      method: 'POST',
      action: 'https://pay.test/',
      fields: { description: '"><script>alert(1)</script>' },
    });
    expect(html).toContain('method="POST"');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});
