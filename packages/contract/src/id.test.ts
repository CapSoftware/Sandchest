import { describe, test, expect } from 'bun:test'
import {
  generateUUIDv7,
  base62Encode,
  base62Decode,
  generateId,
  parseId,
  idToBytes,
  bytesToId,
  SANDBOX_PREFIX,
  EXEC_PREFIX,
  SESSION_PREFIX,
  ARTIFACT_PREFIX,
  IMAGE_PREFIX,
  PROFILE_PREFIX,
  NODE_PREFIX,
  PROJECT_PREFIX,
} from './id.js'

describe('generateUUIDv7', () => {
  test('produces 16 bytes', () => {
    const bytes = generateUUIDv7()
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(16)
  })

  test('version nibble is 7', () => {
    const bytes = generateUUIDv7()
    expect((bytes[6] >> 4) & 0x0f).toBe(7)
  })

  test('variant bits are RFC 4122 (10xx)', () => {
    const bytes = generateUUIDv7()
    expect((bytes[8] >> 6) & 0x03).toBe(2)
  })

  test('embeds current timestamp in first 48 bits', () => {
    const before = Date.now()
    const bytes = generateUUIDv7()
    const after = Date.now()

    const timestamp =
      bytes[0] * 2 ** 40 +
      bytes[1] * 2 ** 32 +
      bytes[2] * 2 ** 24 +
      bytes[3] * 2 ** 16 +
      bytes[4] * 2 ** 8 +
      bytes[5]

    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
  })
})

describe('base62', () => {
  test('round-trip: encode then decode returns original bytes', () => {
    const original = generateUUIDv7()
    const encoded = base62Encode(original)
    const decoded = base62Decode(encoded)
    expect(decoded).toEqual(original)
  })

  test('encoded string is 22 characters', () => {
    const encoded = base62Encode(generateUUIDv7())
    expect(encoded.length).toBe(22)
  })

  test('encoded string uses only base62 characters', () => {
    const encoded = base62Encode(generateUUIDv7())
    expect(encoded).toMatch(/^[0-9A-Za-z]+$/)
  })

  test('round-trip for all-zero bytes', () => {
    const zeros = new Uint8Array(16)
    const encoded = base62Encode(zeros)
    const decoded = base62Decode(encoded)
    expect(decoded).toEqual(zeros)
  })

  test('round-trip for all-max bytes', () => {
    const maxes = new Uint8Array(16).fill(0xff)
    const encoded = base62Encode(maxes)
    const decoded = base62Decode(encoded)
    expect(decoded).toEqual(maxes)
  })

  test('throws on invalid character', () => {
    expect(() => base62Decode('!'.repeat(22))).toThrow('Invalid base62 character')
  })
})

describe('generateId', () => {
  test('produces sortable IDs for the same prefix', () => {
    const a = generateId('sb_')
    // Ensure at least 1ms passes for different timestamp
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }
    const b = generateId('sb_')
    expect(a < b).toBe(true)
  })

  test('two IDs generated 1ms apart are ordered', () => {
    const a = generateId('ex_')
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }
    const b = generateId('ex_')
    expect(a < b).toBe(true)
  })
})

describe('parseId', () => {
  test('parses prefix and bytes correctly', () => {
    const bytes = generateUUIDv7()
    const id = bytesToId('sb_', bytes)
    const parsed = parseId(id)
    expect(parsed.prefix).toBe('sb_')
    expect(parsed.bytes).toEqual(bytes)
  })

  test('works for all resource prefixes', () => {
    const prefixes = [
      SANDBOX_PREFIX,
      EXEC_PREFIX,
      SESSION_PREFIX,
      ARTIFACT_PREFIX,
      IMAGE_PREFIX,
      PROFILE_PREFIX,
      NODE_PREFIX,
      PROJECT_PREFIX,
    ]

    for (const prefix of prefixes) {
      const id = generateId(prefix)
      const parsed = parseId(id)
      expect(parsed.prefix).toBe(prefix)
      expect(parsed.bytes.length).toBe(16)
    }
  })

  test('throws on invalid ID without separator', () => {
    expect(() => parseId('invalidid')).toThrow('missing prefix separator')
  })
})

describe('idToBytes / bytesToId', () => {
  test('round-trip through bytes', () => {
    const id = generateId('art_')
    const bytes = idToBytes(id)
    const reconstructed = bytesToId('art_', bytes)
    expect(reconstructed).toBe(id)
  })
})
