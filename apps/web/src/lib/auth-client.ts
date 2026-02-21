import { createAuthClient } from 'better-auth/client'
import { organizationClient, apiKeyClient, emailOTPClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  plugins: [organizationClient(), apiKeyClient(), emailOTPClient()],
})
