import { betterAuth } from 'better-auth'
import { organization, apiKey, emailOTP } from 'better-auth/plugins'
import { createPool } from 'mysql2/promise'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_BASE_URL ?? 'http://localhost:3000',
  database: createPool({
    uri: process.env.DATABASE_URL!,
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
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL ?? 'Sandchest Auth <noreply@send.sandchest.com>',
          to: email,
          subject: type === 'sign-in' ? `Your Sandchest login code: ${otp}` : `Your Sandchest verification code: ${otp}`,
          text: `Your code is ${otp}. It expires in 5 minutes.`,
        })
      },
    }),
  ],
})
