import type { Metadata } from 'next'
import AuthLayout from '@/components/AuthLayout'
import VerifyOtpForm from '@/components/auth/VerifyOtpForm'

export const metadata: Metadata = {
  title: 'Verify — Sandchest',
}

export default function VerifyPage() {
  return (
    <AuthLayout>
      <VerifyOtpForm />
    </AuthLayout>
  )
}
