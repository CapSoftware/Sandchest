'use client'

import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface VerifyOtpInput {
  email: string
  otp: string
  type: 'sign-in' | 'email-verification'
}

export function useVerifyOtp() {
  return useMutation({
    mutationFn: async ({ email, otp, type }: VerifyOtpInput) => {
      if (type === 'sign-in') {
        const { error } = await authClient.signIn.emailOtp({ email, otp })
        if (error) throw new Error(error.message ?? 'Invalid code')
      } else {
        const { error } = await authClient.emailOtp.verifyEmail({ email, otp })
        if (error) throw new Error(error.message ?? 'Invalid code')
      }
    },
  })
}
