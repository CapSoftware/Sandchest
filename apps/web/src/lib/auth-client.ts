import { createAuthClient } from 'better-auth/react'
import { organizationClient, apiKeyClient, emailOTPClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  plugins: [organizationClient(), apiKeyClient(), emailOTPClient()],
})

export type Session = typeof authClient.$Infer.Session
