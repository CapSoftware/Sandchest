import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'VerifyOtpForm.tsx')

describe('VerifyOtpForm component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useVerifyOtp mutation hook', () => {
    expect(src).toMatch(/import.*useVerifyOtp.*from/)
    expect(src).toMatch(/useVerifyOtp\(\)/)
  })

  test('uses useSendOtp mutation hook for resend', () => {
    expect(src).toMatch(/import.*useSendOtp.*from/)
    expect(src).toMatch(/resendOtp.*=.*useSendOtp\(\)/)
  })

  test('does not call authClient directly', () => {
    expect(src).not.toMatch(/authClient\.emailOtp/)
    expect(src).not.toMatch(/import.*authClient/)
  })

  test('uses useSearchParams instead of window.location.search', () => {
    expect(src).toMatch(/import.*useSearchParams.*from ['"]next\/navigation['"]/)
    expect(src).toMatch(/useSearchParams\(\)/)
    expect(src).not.toMatch(/new URLSearchParams\(window\.location\.search\)/)
  })

  test('uses mutation.mutate for verify', () => {
    expect(src).toMatch(/verifyOtp\.mutate\(/)
  })

  test('uses mutation.mutate for resend', () => {
    expect(src).toMatch(/resendOtp\.mutate\(/)
  })

  test('derives loading state from mutations', () => {
    expect(src).toMatch(/verifyOtp\.isPending/)
    expect(src).toMatch(/resendOtp\.isPending/)
  })

  test('derives error state from mutations', () => {
    expect(src).toMatch(/verifyOtp\.error/)
    expect(src).toMatch(/resendOtp\.error/)
  })

  test('resets mutation errors on digit change', () => {
    expect(src).toMatch(/verifyOtp\.reset\(\)/)
    expect(src).toMatch(/resendOtp\.reset\(\)/)
  })

  test('does not use manual loading or error state', () => {
    expect(src).not.toMatch(/useState\(false\)/)
    expect(src).not.toMatch(/useState\(''\)/)
    expect(src).not.toMatch(/setLoading/)
    expect(src).not.toMatch(/setError/)
    expect(src).not.toMatch(/setResent/)
  })

  test('shows resend success from mutation state', () => {
    expect(src).toMatch(/resendOtp\.isSuccess/)
  })

  test('redirects to dashboard on successful verify', () => {
    expect(src).toMatch(/window\.location\.href\s*=\s*['"]\/dashboard['"]/)
  })

  test('renders 6 OTP digit inputs', () => {
    expect(src).toMatch(/OTP_LENGTH\s*=\s*6/)
    expect(src).toMatch(/digits\.map/)
  })

  test('supports paste handling', () => {
    expect(src).toMatch(/handlePaste/)
    expect(src).toMatch(/clipboardData/)
  })

  test('auto-verifies when all digits are entered', () => {
    const handleChangeBlock = src.slice(
      src.indexOf('function handleChange'),
      src.indexOf('function handleKeyDown'),
    )
    expect(handleChangeBlock).toMatch(/verify\(completed\)/)
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
