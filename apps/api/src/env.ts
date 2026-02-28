/**
 * Centralized environment configuration.
 *
 * On ECS, SST injects linked resources and secrets as SST_RESOURCE_<Name>
 * environment variables (JSON-encoded). During local development, values
 * come from the root .env file as plain environment variables.
 *
 * Resolution order per variable:
 *   1. SST-linked resource/secret (SST_RESOURCE_*)
 *   2. Plain environment variable (process.env.*)
 *   3. Default value (for optional/config vars)
 */

/**
 * Read an SST-linked resource from the injected environment.
 * SST sets SST_RESOURCE_<Name> as JSON for each linked resource/secret.
 */
export function sstResource<T>(name: string): T | undefined {
  const raw = process.env[`SST_RESOURCE_${name}`]
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

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
  // SST-linked infrastructure resources
  const redis = sstResource<{ host: string; port: number }>('Redis')
  const bucket = sstResource<{ name: string }>('ArtifactBucket')

  return {
    // Server config (always from plain env vars — set by SST environment block)
    PORT: Number(optional('PORT', '3001')),
    NODE_ENV: optional('NODE_ENV', 'development'),
    DRAIN_TIMEOUT_MS: Number(optional('DRAIN_TIMEOUT_MS', '30000')),

    // Required secrets: SST-linked first, then plain env var fallback
    DATABASE_URL:
      sstResource<{ value: string }>('DatabaseUrl')?.value
      ?? required('DATABASE_URL'),
    BETTER_AUTH_SECRET:
      sstResource<{ value: string }>('BetterAuthSecret')?.value
      ?? required('BETTER_AUTH_SECRET'),
    RESEND_API_KEY:
      sstResource<{ value: string }>('ResendApiKey')?.value
      ?? required('RESEND_API_KEY'),

    // Optional secrets: SST-linked first, then plain env var
    AUTUMN_SECRET_KEY:
      sstResource<{ value: string }>('AutumnSecretKey')?.value
      ?? (process.env.AUTUMN_SECRET_KEY as string | undefined),

    // Redis: construct URL from SST-linked resource, or use plain env var
    REDIS_URL: redis
      ? `redis://${redis.host}:${redis.port}`
      : (process.env.REDIS_URL as string | undefined),

    // S3 bucket: SST-linked resource, or plain env var
    ARTIFACT_BUCKET_NAME: bucket?.name
      ?? (process.env.ARTIFACT_BUCKET_NAME as string | undefined),

    // S3-compatible object storage (Scaleway / R2 / MinIO)
    SANDCHEST_S3_ENDPOINT: process.env.SANDCHEST_S3_ENDPOINT as string | undefined,
    SANDCHEST_S3_ACCESS_KEY: process.env.SANDCHEST_S3_ACCESS_KEY as string | undefined,
    SANDCHEST_S3_SECRET_KEY: process.env.SANDCHEST_S3_SECRET_KEY as string | undefined,
    SANDCHEST_S3_REGION: optional('SANDCHEST_S3_REGION', 'auto'),

    // Node daemon gRPC (mTLS)
    NODE_GRPC_ADDR: process.env.NODE_GRPC_ADDR as string | undefined,
    NODE_GRPC_CERT_PATH: process.env.NODE_GRPC_CERT_PATH as string | undefined,
    NODE_GRPC_KEY_PATH: process.env.NODE_GRPC_KEY_PATH as string | undefined,
    NODE_GRPC_CA_PATH: process.env.NODE_GRPC_CA_PATH as string | undefined,

    // Admin API token for /v1/admin/* endpoints
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN as string | undefined,

    // Config (always from plain env vars)
    BETTER_AUTH_BASE_URL: optional('BETTER_AUTH_BASE_URL', 'http://localhost:3001'),
    RESEND_FROM_EMAIL: optional('RESEND_FROM_EMAIL', 'Sandchest Auth <noreply@send.sandchest.com>'),
  }
}

export type Env = ReturnType<typeof loadEnv>
