import { betterAuth } from 'better-auth'
import { organization, apiKey, emailOTP } from 'better-auth/plugins'
import { createPool } from 'mysql2/promise'
import { Resend } from 'resend'
import { loadEnv } from './env.js'

const env = loadEnv()

let _resend: Resend | undefined
function getResend() {
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY)
  return _resend
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: ['http://localhost:3000'],
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
        await getResend().emails.send({
          from: env.RESEND_FROM_EMAIL,
          to: email,
          subject: type === 'sign-in' ? `Your Sandchest login code: ${otp}` : `Your Sandchest verification code: ${otp}`,
          text: `Your code is ${otp}. It expires in 5 minutes.`,
        })
      },
    }),
  ],
})
