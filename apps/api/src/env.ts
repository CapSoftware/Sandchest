/**
 * Centralized environment configuration.
 *
 * All secrets are injected by SST via the ECS task environment.
 * During local development they come from the root .env file.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

/** Lazily load and validate all environment variables. */
export function loadEnv() {
  return {
    // Server
    PORT: Number(optional('PORT', '3001')),
    NODE_ENV: optional('NODE_ENV', 'development'),
    DRAIN_TIMEOUT_MS: Number(optional('DRAIN_TIMEOUT_MS', '30000')),

    // Secrets (required — SST secrets)
    DATABASE_URL: required('DATABASE_URL'),
    BETTER_AUTH_SECRET: required('BETTER_AUTH_SECRET'),
    RESEND_API_KEY: required('RESEND_API_KEY'),

    // Secrets (optional — graceful no-op fallback)
    AUTUMN_SECRET_KEY: process.env.AUTUMN_SECRET_KEY as string | undefined,
    REDIS_URL: process.env.REDIS_URL as string | undefined,

    // Config (SST service environment)
    BETTER_AUTH_BASE_URL: optional('BETTER_AUTH_BASE_URL', 'http://localhost:3001'),
    RESEND_FROM_EMAIL: optional('RESEND_FROM_EMAIL', 'Sandchest Auth <noreply@send.sandchest.com>'),
  }
}

export type Env = ReturnType<typeof loadEnv>
