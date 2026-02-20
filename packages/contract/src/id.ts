import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = 62n
const ENCODED_LENGTH = 22

// Resource ID prefixes
export const SANDBOX_PREFIX = 'sb_'
export const EXEC_PREFIX = 'ex_'
export const SESSION_PREFIX = 'sess_'
export const ARTIFACT_PREFIX = 'art_'
export const IMAGE_PREFIX = 'img_'
export const PROFILE_PREFIX = 'prof_'
export const NODE_PREFIX = 'node_'
export const PROJECT_PREFIX = 'proj_'

/**
 * Generate a UUIDv7 as raw 16 bytes.
 * Structure: 48-bit ms timestamp | 4-bit version (0111) | 12-bit random | 2-bit variant (10) | 62-bit random
 */
export function generateUUIDv7(): Uint8Array {
  const bytes = new Uint8Array(16)
  const timestamp = Date.now()

  // Write 48-bit timestamp big-endian (use division to avoid 32-bit bitwise truncation)
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff

  // Fill remaining 10 bytes with random data
  const random = randomBytes(10)
  bytes.set(random, 6)

  // Set version to 7 (bits 48-51 = 0111)
  bytes[6] = (bytes[6] & 0x0f) | 0x70

  // Set variant to RFC 4122 (bits 64-65 = 10)
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return bytes
}

/** Encode 16 bytes as a fixed-length 22-character base62 string. */
export function base62Encode(bytes: Uint8Array): string {
  let num = 0n
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte)
  }

  const chars = new Array<string>(ENCODED_LENGTH)
  for (let i = ENCODED_LENGTH - 1; i >= 0; i--) {
    chars[i] = ALPHABET[Number(num % BASE)]
    num /= BASE
  }

  return chars.join('')
}

/** Decode a 22-character base62 string back to 16 bytes. */
export function base62Decode(str: string): Uint8Array {
  let num = 0n
  for (const char of str) {
    const idx = ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid base62 character: ${char}`)
    num = num * BASE + BigInt(idx)
  }

  const bytes = new Uint8Array(16)
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(num & 0xffn)
    num >>= 8n
  }

  return bytes
}

/** Generate a prefixed ID: `{prefix}{base62(uuidv7)}` */
export function generateId(prefix: string): string {
  return bytesToId(prefix, generateUUIDv7())
}

/** Parse a prefixed ID back to its prefix and raw bytes. */
export function parseId(id: string): { prefix: string; bytes: Uint8Array } {
  const idx = id.lastIndexOf('_')
  if (idx === -1) throw new Error('Invalid ID format: missing prefix separator')
  const prefix = id.slice(0, idx + 1)
  const encoded = id.slice(idx + 1)
  return { prefix, bytes: base62Decode(encoded) }
}

/** Strip prefix and decode to raw 16 bytes (for DB storage). */
export function idToBytes(id: string): Uint8Array {
  return parseId(id).bytes
}

/** Encode raw bytes to a prefixed ID. */
export function bytesToId(prefix: string, bytes: Uint8Array): string {
  return prefix + base62Encode(bytes)
}
