import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Effect, Layer } from 'effect'
import { ObjectStorage, type ObjectStorageApi } from './object-storage.js'

export interface S3Config {
  readonly endpoint: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region: string
  readonly bucket: string
}

function createS3ObjectStorageApi(client: S3Client, bucket: string): ObjectStorageApi {
  return {
    putObject: (key, body) =>
      Effect.promise(async () => {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: typeof body === 'string' ? Buffer.from(body) : body,
          }),
        )
      }),

    getObject: (key) =>
      Effect.promise(async () => {
        try {
          const response = await client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
            }),
          )
          if (!response.Body) return null
          return response.Body.transformToString('utf-8')
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'name' in err &&
            (err as { name: string }).name === 'NoSuchKey'
          ) {
            return null
          }
          throw err
        }
      }),

    getPresignedUrl: (key, expiresInSeconds) =>
      Effect.promise(async () => {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
        return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
      }),

    deleteObject: (key) =>
      Effect.promise(async () => {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        )
      }),
  }
}

/** Create an ObjectStorage Layer from S3-compatible configuration. */
export function createObjectStorageLayer(config: S3Config): Layer.Layer<ObjectStorage> {
  return Layer.sync(ObjectStorage, () => {
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    })
    return createS3ObjectStorageApi(client, config.bucket)
  })
}
