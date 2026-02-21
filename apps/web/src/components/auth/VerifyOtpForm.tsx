'use client'

import { useState, useRef, useEffect } from 'react'
import { authClient } from '@/lib/auth-client'
import ErrorMessage from '@/components/ui/ErrorMessage'

const OTP_LENGTH = 6

export default function VerifyOtpForm() {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resent, setResent] = useState(false)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const params = new URLSearchParams(window.location.search)
  const email = params.get('email') ?? ''
  const type = params.get('type') === 'sign-up' ? 'sign-up' as const : 'sign-in' as const
  const otpType = type === 'sign-up' ? 'email-verification' as const : type

  const otp = digits.join('')
  const isComplete = otp.length === OTP_LENGTH && /^\d+$/.test(otp)

  useEffect(() => {
    if (!email) {
      window.location.href = '/login'
      return
    }
    inputRefs.current[0]?.focus()
  }, [email])

  function handleChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return

    const next = [...digits]
    next[index] = value.slice(-1)
    setDigits(next)
    if (error) setError('')

    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }

    const completed = next.join('')
    if (completed.length === OTP_LENGTH && /^\d+$/.test(completed)) {
      verify(completed)
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return

    const next = [...digits]
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i]
    }
    setDigits(next)

    if (pasted.length === OTP_LENGTH) {
      verify(pasted)
    } else {
      inputRefs.current[pasted.length]?.focus()
    }
  }

  async function verify(code: string) {
    setLoading(true)
    setError('')

    try {
      const { error: authError } = await authClient.emailOtp.verifyEmail({
        email,
        otp: code,
      })

      if (authError) {
        setError(authError.message ?? 'Invalid code')
        setLoading(false)
        setDigits(Array(OTP_LENGTH).fill(''))
        inputRefs.current[0]?.focus()
        return
      }

      window.location.href = '/'
    } catch {
      setError('Something went wrong. Try again.')
      setLoading(false)
    }
  }

  async function handleResend() {
    setResent(false)
    setError('')

    try {
      const { error: authError } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: otpType,
      })

      if (authError) {
        setError(authError.message ?? 'Failed to resend code')
        return
      }

      setResent(true)
      setDigits(Array(OTP_LENGTH).fill(''))
      inputRefs.current[0]?.focus()
    } catch {
      setError('Failed to resend code')
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (isComplete) {
      verify(otp)
    }
  }

  if (!email) return null

  return (
    <div className="auth-form-wrapper">
      <div className="auth-form-header">
        <h1 className="auth-heading">Check your email</h1>
        <p className="auth-description">
          We sent a 6-digit code to <strong>{email}</strong>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="otp-inputs">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={i === 0 ? handlePaste : undefined}
              className="otp-digit"
              disabled={loading}
              aria-label={`Digit ${i + 1}`}
            />
          ))}
        </div>

        {error && <ErrorMessage message={error} className="auth-error" role="alert" />}
        {resent && <p className="auth-success" role="status">Code resent</p>}

        <button type="submit" className="auth-button" disabled={loading || !isComplete}>
          {loading ? 'Verifying...' : 'Verify'}
        </button>
      </form>

      <p className="auth-alt-link">
        {"Didn't receive a code? "}
        <button type="button" onClick={handleResend} className="auth-link-button" disabled={loading}>
          Resend
        </button>
      </p>
    </div>
  )
}
