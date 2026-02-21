import type { Metadata } from 'next'
import AuthLayout from '@/components/AuthLayout'
import EmailForm from '@/components/auth/EmailForm'

export const metadata: Metadata = {
  title: 'Sign up — Sandchest',
}

export default function SignupPage() {
  return (
    <AuthLayout>
      <EmailForm
        heading="Create your account"
        description="Enter your email to get started with Sandchest."
        buttonText="Get started"
        type="sign-up"
        altText="Already have an account?"
        altActionText="Log in"
        altHref="/login"
      />
    </AuthLayout>
  )
}
