import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type HashAlgorithm = 'md5' | 'sha1' | 'sha256';

export function hashHex(algorithm: HashAlgorithm, data: string | Buffer): string {
  return createHash(algorithm).update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time string comparison. Hex digests are compared case-insensitively. */
export function safeEqual(a: string | undefined, b: string | undefined, { ignoreCase = true } = {}): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(ignoreCase ? a.toLowerCase() : a);
  const right = Buffer.from(ignoreCase ? b.toLowerCase() : b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Unsigned CRC-32 (IEEE 802.3), as required by PayPal's webhook signature. */
export function crc32(data: string | Buffer): number {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
