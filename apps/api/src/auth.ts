import { betterAuth } from 'better-auth'
import { organization, apiKey, emailOTP } from 'better-auth/plugins'
import { createPool } from 'mysql2/promise'
import { Resend } from 'resend'
import { loadEnv } from './env.js'

let _resend: Resend | undefined

function getResend(resendApiKey: string) {
  if (!_resend) _resend = new Resend(resendApiKey)
  return _resend
}

function createAuth() {
  const env = loadEnv()
  return betterAuth({
    baseURL: env.BETTER_AUTH_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [
      'http://localhost:3000',
      'https://sandchest.com',
      'https://*.sandchest.com',
    ],
    database: createPool({
      uri: env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
    }),
    plugins: [
      organization(),
      apiKey({
        enableMetadata: true,
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        async sendVerificationOTP({ email, otp, type }) {
          await getResend(env.RESEND_API_KEY).emails.send({
            from: env.RESEND_FROM_EMAIL,
            to: email,
            subject: type === 'sign-in' ? `Your Sandchest login code: ${otp}` : `Your Sandchest verification code: ${otp}`,
            text: `Your code is ${otp}. It expires in 5 minutes.`,
          })
        },
      }),
    ],
  })
}

type AuthInstance = ReturnType<typeof createAuth>

let _auth: AuthInstance | undefined

function getAuth(): AuthInstance {
  if (!_auth) _auth = createAuth()
  return _auth
}

/** Lazily initialized BetterAuth instance — env is validated on first access, not at import time. */
export const auth: AuthInstance = new Proxy({} as AuthInstance, {
  get(_target, prop, receiver) {
    return Reflect.get(getAuth(), prop, receiver)
  },
})
