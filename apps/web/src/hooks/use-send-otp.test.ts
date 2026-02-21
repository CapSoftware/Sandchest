import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-send-otp.ts')

describe('useSendOtp hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useMutation from @tanstack/react-query', () => {
    expect(src).toMatch(/import.*useMutation.*from ['"]@tanstack\/react-query['"]/)
  })

  test('imports authClient', () => {
    expect(src).toMatch(/import.*authClient.*from/)
  })

  test('exports useSendOtp function', () => {
    expect(src).toMatch(/export function useSendOtp/)
  })

  test('calls authClient.emailOtp.sendVerificationOtp', () => {
    expect(src).toMatch(/authClient\.emailOtp\.sendVerificationOtp/)
  })

  test('returns a useMutation result', () => {
    expect(src).toMatch(/return useMutation/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\) throw new Error/)
  })

  test('does not use useState for loading or error state', () => {
    expect(src).not.toMatch(/useState/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('does not use any type', () => {
    const lines = src.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//')) continue
      expect(trimmed).not.toMatch(/:\s*any\b/)
      expect(trimmed).not.toMatch(/as\s+any\b/)
    }
  })
})
