import type { Metadata } from 'next'
import AuthLayout from '@/components/AuthLayout'
import EmailForm from '@/components/auth/EmailForm'

export const metadata: Metadata = {
  title: 'Log in — Sandchest',
}

export default function LoginPage() {
  return (
    <AuthLayout>
      <EmailForm
        heading="Log in to Sandchest"
        description="Enter your email and we'll send you a verification code."
        buttonText="Send code"
        type="sign-in"
        altText="Don't have an account?"
        altActionText="Sign up"
        altHref="/signup"
      />
    </AuthLayout>
  )
}
