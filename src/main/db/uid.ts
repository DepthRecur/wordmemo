import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(time: number, length: number): string {
  let value = Math.max(0, Math.trunc(time))
  let out = ''
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

/**
 * ULID：26 位 Crockford base32，前 10 位时间（毫秒）+ 后 16 位随机。
 * 只给「将来同步用的稳定 id」占位（decks.uid），本版不需要解析。
 */
export function newUid(time: number = Date.now()): string {
  const bytes = randomBytes(10)
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  let random = ''
  for (let i = 0; i < 16; i++) {
    random = CROCKFORD[Number(bits & 31n)] + random
    bits >>= 5n
  }
  return encodeTime(time, 10) + random
}
