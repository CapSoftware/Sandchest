'use client'

import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface VerifyOtpInput {
  email: string
  otp: string
}

export function useVerifyOtp() {
  return useMutation({
    mutationFn: async ({ email, otp }: VerifyOtpInput) => {
      const { error } = await authClient.emailOtp.verifyEmail({ email, otp })
      if (error) throw new Error(error.message ?? 'Invalid code')
    },
  })
}
