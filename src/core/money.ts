import { PaymentValidationError } from './errors.js';

/**
 * ISO 4217 minor-unit exponents. Anything not listed defaults to 2.
 * Providers sometimes deviate; adapters handle those quirks explicitly.
 */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyDecimals(currency: string): number {
  const code = normalizeCurrency(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function normalizeCurrency(currency: string): string {
  const code = String(currency ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new PaymentValidationError(`Invalid ISO 4217 currency code: "${currency}"`);
  }
  return code;
}

export function assertMinorUnits(amount: number, field = 'amount'): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PaymentValidationError(
      `${field} must be a positive integer in minor units (e.g. 150000 for 1,500.00); received ${amount}`,
    );
  }
}

/**
 * Minor units -> decimal string with the currency's exponent.
 * 150000 COP -> "1500.00", 1500 CLP -> "1500". No floating point involved.
 */
export function toDecimalString(amountMinor: number, currency: string, decimals = currencyDecimals(currency)): string {
  assertMinorUnits(amountMinor);
  if (decimals === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** Decimal (string or number) -> integer minor units, exact for well-formed input. */
export function toMinorUnits(value: string | number, currency: string, decimals = currencyDecimals(currency)): number {
  const text = typeof value === 'number' ? value.toFixed(decimals) : String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new PaymentValidationError(`Invalid decimal amount: "${value}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const roundUp = decimals < fraction.length && Number(fraction[decimals]) >= 5;
  const minor = Number(whole) * 10 ** decimals + Number(padded || 0) + (roundUp ? 1 : 0);
  return sign ? -minor : minor;
}
