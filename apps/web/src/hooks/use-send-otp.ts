'use client'

import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface SendOtpInput {
  email: string
  type: 'sign-in' | 'email-verification'
}

export function useSendOtp() {
  return useMutation({
    mutationFn: async ({ email, type }: SendOtpInput) => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type,
      })
      if (error) throw new Error(error.message ?? 'Failed to send code')
    },
  })
}
