import { Context, type Effect } from 'effect'

/** Object storage service for S3-compatible storage (Scaleway). */
export interface ObjectStorageApi {
  /** Write an object to a bucket. Overwrites if exists. */
  readonly putObject: (
    key: string,
    body: Uint8Array | string,
  ) => Effect.Effect<void, never, never>

  /** Read an object from a bucket. Returns null if not found. */
  readonly getObject: (
    key: string,
  ) => Effect.Effect<string | null, never, never>

  /** Generate a pre-signed URL for downloading an object. */
  readonly getPresignedUrl: (
    key: string,
    expiresInSeconds: number,
  ) => Effect.Effect<string, never, never>
}

export class ObjectStorage extends Context.Tag('ObjectStorage')<ObjectStorage, ObjectStorageApi>() {}
