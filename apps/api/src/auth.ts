import { betterAuth } from 'better-auth'
import { organization, apiKey } from 'better-auth/plugins'
import { createPool } from 'mysql2/promise'

export const auth = betterAuth({
  database: createPool({
    uri: process.env.DATABASE_URL!,
    waitForConnections: true,
    connectionLimit: 10,
  }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [
    organization(),
    apiKey({
      enableMetadata: true,
    }),
  ],
})
