import type { Metadata } from 'next'
import AuthLayout from '@/components/AuthLayout'
import OnboardingForm from '@/components/onboarding/OnboardingForm'

export const metadata: Metadata = {
  title: 'Get Started — Sandchest',
}

export default function OnboardingPage() {
  return (
    <AuthLayout>
      <OnboardingForm />
    </AuthLayout>
  )
}
