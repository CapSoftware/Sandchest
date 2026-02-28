/**
 * Centralized environment configuration.
 *
 * All values come from plain environment variables (process.env.*).
 * In production, these are set via Fly.io secrets and env config.
 * During local development, values come from the root .env file.
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
    // Server config
    PORT: Number(optional('PORT', '3001')),
    NODE_ENV: optional('NODE_ENV', 'development'),
    DRAIN_TIMEOUT_MS: Number(optional('DRAIN_TIMEOUT_MS', '30000')),

    // Required secrets
    DATABASE_URL: required('DATABASE_URL'),
    BETTER_AUTH_SECRET: required('BETTER_AUTH_SECRET'),
    RESEND_API_KEY: required('RESEND_API_KEY'),

    // Optional secrets
    AUTUMN_SECRET_KEY: process.env.AUTUMN_SECRET_KEY as string | undefined,

    // Redis (set REDIS_FAMILY=6 for IPv6, e.g. Upstash on Fly.io)
    REDIS_URL: process.env.REDIS_URL as string | undefined,
    REDIS_FAMILY: process.env.REDIS_FAMILY === '6' ? (6 as const) : undefined,

    // S3-compatible object storage (R2 / MinIO)
    ARTIFACT_BUCKET_NAME: process.env.ARTIFACT_BUCKET_NAME as string | undefined,
    SANDCHEST_S3_ENDPOINT: process.env.SANDCHEST_S3_ENDPOINT as string | undefined,
    SANDCHEST_S3_ACCESS_KEY: process.env.SANDCHEST_S3_ACCESS_KEY as string | undefined,
    SANDCHEST_S3_SECRET_KEY: process.env.SANDCHEST_S3_SECRET_KEY as string | undefined,
    SANDCHEST_S3_REGION: optional('SANDCHEST_S3_REGION', 'auto'),

    // Node daemon gRPC (mTLS)
    NODE_GRPC_ADDR: process.env.NODE_GRPC_ADDR as string | undefined,
    NODE_GRPC_NODE_ID: process.env.NODE_GRPC_NODE_ID as string | undefined,
    // mTLS via file paths (local dev)
    NODE_GRPC_CERT_PATH: process.env.NODE_GRPC_CERT_PATH as string | undefined,
    NODE_GRPC_KEY_PATH: process.env.NODE_GRPC_KEY_PATH as string | undefined,
    NODE_GRPC_CA_PATH: process.env.NODE_GRPC_CA_PATH as string | undefined,
    // mTLS via PEM content (Fly.io secrets — preferred in production)
    MTLS_CA_PEM: process.env.MTLS_CA_PEM as string | undefined,
    MTLS_CLIENT_CERT_PEM: process.env.MTLS_CLIENT_CERT_PEM as string | undefined,
    MTLS_CLIENT_KEY_PEM: process.env.MTLS_CLIENT_KEY_PEM as string | undefined,

    // Admin API token for /v1/admin/* endpoints
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN as string | undefined,

    // Config
    BETTER_AUTH_BASE_URL: optional('BETTER_AUTH_BASE_URL', 'http://localhost:3001'),
    RESEND_FROM_EMAIL: optional('RESEND_FROM_EMAIL', 'Sandchest Auth <noreply@send.sandchest.com>'),
  }
}

export type Env = ReturnType<typeof loadEnv>
