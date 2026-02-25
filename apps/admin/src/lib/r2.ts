import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

let client: S3Client | null = null

function getR2Client(): S3Client {
  if (client) return client
  const endpoint = process.env.R2_ENDPOINT
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
  }
  client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  })
  return client
}

/**
 * Generate a presigned URL for the sandchest-node binary in R2.
 * Defaults to the `latest` build. Pass a git SHA to get a specific version.
 */
export async function presignDaemonBinary(version = 'latest', expiresIn = 3600): Promise<string> {
  const bucket = process.env.R2_BUCKET
  if (!bucket) throw new Error('R2_BUCKET is not configured')

  const key = `binaries/sandchest-node/${version}/sandchest-node`
  const command = new GetObjectCommand({ Bucket: bucket, Key: key })
  return getSignedUrl(getR2Client(), command, { expiresIn })
}
