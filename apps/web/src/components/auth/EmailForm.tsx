'use client'

import { useState } from 'react'
import Link from 'next/link'
import { authClient } from '@/lib/auth-client'
import { isValidEmail } from '@/lib/validation'
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
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const otpType = type === 'sign-up' ? 'email-verification' as const : type

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')

    const trimmed = email.trim()
    if (!isValidEmail(trimmed)) {
      setError('Enter a valid email address')
      return
    }

    setLoading(true)
    try {
      const { error: authError } = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: otpType,
      })

      if (authError) {
        setError(authError.message ?? 'Failed to send code')
        setLoading(false)
        return
      }

      window.location.href = `/verify?email=${encodeURIComponent(trimmed)}&type=${type}`
    } catch {
      setError('Something went wrong. Try again.')
      setLoading(false)
    }
  }

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
          autoFocus
          placeholder="you@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (error) setError('')
          }}
          className="auth-input"
          disabled={loading}
        />

        {error && <ErrorMessage message={error} className="auth-error" role="alert" />}

        <button type="submit" className="auth-button" disabled={loading || !email.trim()}>
          {loading ? 'Sending...' : buttonText}
        </button>
      </form>

      <p className="auth-alt-link">
        {altText} <Link href={altHref}>{altActionText}</Link>
      </p>
    </div>
  )
}
