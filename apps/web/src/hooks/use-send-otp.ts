'use client'

import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface SendOtpInput {
  email: string
  type: 'sign-in'
}

export function useSendOtp() {
  return useMutation({
    mutationFn: async ({ email, type }: SendOtpInput) => {
      console.log('[send-otp] calling sendVerificationOtp', { email, type })
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type,
      })
      console.log('[send-otp] full response', JSON.stringify(result, null, 2))
      if (result.error) throw new Error(result.error.message ?? 'Failed to send code')
      return result.data
    },
  })
}
