import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { AdminConfig } from './config.js'

function getR2Client(config: AdminConfig): S3Client {
  const r2 = config.r2
  if (!r2?.endpoint || !r2.accessKeyId || !r2.secretAccessKey) {
    throw new Error('R2 credentials not configured. Run `sandchest-admin init` to set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.')
  }
  return new S3Client({
    region: 'auto',
    endpoint: r2.endpoint,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  })
}

/**
 * Generate a presigned URL for the sandchest-node binary in R2.
 * Defaults to the `latest` build. Pass a git SHA to get a specific version.
 */
export async function presignDaemonBinary(
  config: AdminConfig,
  version = 'latest',
  expiresIn = 3600,
): Promise<string> {
  const bucket = config.r2?.bucket
  if (!bucket) throw new Error('R2_BUCKET is not configured. Run `sandchest-admin init`.')

  const key = `binaries/sandchest-node/${version}/sandchest-node`
  const command = new GetObjectCommand({ Bucket: bucket, Key: key })
  return getSignedUrl(getR2Client(config), command, { expiresIn })
}
