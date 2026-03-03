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
      console.log('[verify-otp] calling signIn.emailOtp', { email })
      const result = await authClient.signIn.emailOtp({ email, otp })
      console.log('[verify-otp] full response', JSON.stringify(result, null, 2))
      console.log('[verify-otp] data', result.data)
      console.log('[verify-otp] error', result.error)
      console.log('[verify-otp] cookies after verify', document.cookie)
      if (result.error) throw new Error(result.error.message ?? 'Invalid code')
      return result.data
    },
  })
}
