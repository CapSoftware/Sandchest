'use client'

import { useState } from 'react'
import Link from 'next/link'
import { isValidEmail } from '@/lib/validation'
import { useSendOtp } from '@/hooks/use-send-otp'
import ErrorMessage from '@/components/ui/ErrorMessage'

interface EmailFormProps {
  heading: string
  description: string
  buttonText: string
  type: 'sign-in' | 'sign-up'
  altText: string
  altActionText: string
  altHref: string
}

export default function EmailForm({
  heading,
  description,
  buttonText,
  type,
  altText,
  altActionText,
  altHref,
}: EmailFormProps) {
  const [email, setEmail] = useState('')
  const [validationError, setValidationError] = useState('')
  const sendOtp = useSendOtp()

  const otpType = type === 'sign-up' ? ('email-verification' as const) : type

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const trimmed = email.trim()
    if (!isValidEmail(trimmed)) {
      setValidationError('Enter a valid email address')
      return
    }
    setValidationError('')

    sendOtp.mutate(
      { email: trimmed, type: otpType },
      {
        onSuccess() {
          window.location.href = `/verify?email=${encodeURIComponent(trimmed)}&type=${type}`
        },
      },
    )
  }

  const error = validationError || (sendOtp.error?.message ?? '')

  return (
    <div className="auth-form-wrapper">
      <div className="auth-form-header">
        <h1 className="auth-heading">{heading}</h1>
        <p className="auth-description">{description}</p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label htmlFor="email" className="auth-label">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (validationError) setValidationError('')
            if (sendOtp.error) sendOtp.reset()
          }}
          className="auth-input"
          disabled={sendOtp.isPending}
        />

        {error && <ErrorMessage message={error} className="auth-error" role="alert" />}

        <button type="submit" className="auth-button" disabled={sendOtp.isPending || !email.trim()}>
          {sendOtp.isPending ? 'Sending...' : buttonText}
        </button>
      </form>

      <p className="auth-alt-link">
        {altText} <Link href={altHref}>{altActionText}</Link>
      </p>
    </div>
  )
}
