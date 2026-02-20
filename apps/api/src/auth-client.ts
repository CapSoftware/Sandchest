import { createAuthClient } from 'better-auth/client'
import { organizationClient, apiKeyClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [organizationClient(), apiKeyClient()],
})
