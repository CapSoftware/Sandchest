import { Effect } from 'effect'
import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryObjectStorage } from './object-storage.memory.js'
import type { ObjectStorageApi } from './object-storage.js'

let storage: ObjectStorageApi

function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(effect)
}

beforeEach(() => {
  storage = createInMemoryObjectStorage()
})

// ---------------------------------------------------------------------------
// putObject / getObject
// ---------------------------------------------------------------------------

describe('putObject and getObject', () => {
  test('string round-trip', async () => {
    await run(storage.putObject('test/key.txt', 'hello world'))
    const result = await run(storage.getObject('test/key.txt'))
    expect(result).toBe('hello world')
  })

  test('Uint8Array round-trip', async () => {
    const data = new TextEncoder().encode('binary content')
    await run(storage.putObject('data/bin.dat', data))
    const result = await run(storage.getObject('data/bin.dat'))
    expect(result).toBe('binary content')
  })

  test('returns null for non-existent key', async () => {
    const result = await run(storage.getObject('does/not/exist'))
    expect(result).toBeNull()
  })

  test('overwrites existing key', async () => {
    await run(storage.putObject('key', 'first'))
    await run(storage.putObject('key', 'second'))
    const result = await run(storage.getObject('key'))
    expect(result).toBe('second')
  })

  test('different keys are independent', async () => {
    await run(storage.putObject('a', 'value-a'))
    await run(storage.putObject('b', 'value-b'))
    expect(await run(storage.getObject('a'))).toBe('value-a')
    expect(await run(storage.getObject('b'))).toBe('value-b')
  })

  test('supports nested path-like keys', async () => {
    const key = 'org_123/sb_456/events.jsonl'
    await run(storage.putObject(key, '{"seq":1}'))
    const result = await run(storage.getObject(key))
    expect(result).toBe('{"seq":1}')
  })

  test('handles empty string content', async () => {
    await run(storage.putObject('empty', ''))
    const result = await run(storage.getObject('empty'))
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// getPresignedUrl
// ---------------------------------------------------------------------------

describe('getPresignedUrl', () => {
  test('returns a URL-like string containing the key', async () => {
    const url = await run(storage.getPresignedUrl('org/file.txt', 3600))
    expect(url).toContain('org/file.txt')
  })

  test('includes expiry in URL', async () => {
    const url = await run(storage.getPresignedUrl('key', 7200))
    expect(url).toContain('7200')
  })

  test('works for non-existent keys (pre-signed URLs dont require existence)', async () => {
    const url = await run(storage.getPresignedUrl('missing/key', 300))
    expect(typeof url).toBe('string')
    expect(url.length).toBeGreaterThan(0)
  })
})
