import type { Metadata } from 'next'
import AuthLayout from '@/components/AuthLayout'
import OnboardingForm from '@/components/onboarding/OnboardingForm'
import OnboardingBillingProvider from '@/components/onboarding/OnboardingBillingProvider'

export const metadata: Metadata = {
  title: 'Get Started — Sandchest',
}

export default function OnboardingPage() {
  return (
    <AuthLayout>
      <OnboardingBillingProvider>
        <OnboardingForm />
      </OnboardingBillingProvider>
    </AuthLayout>
  )
}
