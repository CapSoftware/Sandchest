import { Data } from 'effect'
import { HttpServerResponse } from '@effect/platform'

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
  readonly message: string
}> {}

export class UnauthorizedError extends Data.TaggedError('UnauthorizedError')<{
  readonly message: string
}> {}

export class ForbiddenError extends Data.TaggedError('ForbiddenError')<{
  readonly message: string
}> {}

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string
}> {}

export class ConflictError extends Data.TaggedError('ConflictError')<{
  readonly message: string
}> {}

export class RateLimitedError extends Data.TaggedError('RateLimitedError')<{
  readonly message: string
  readonly retryAfter: number
}> {}

export class SandboxNotRunningError extends Data.TaggedError('SandboxNotRunningError')<{
  readonly message: string
}> {}

export class NoCapacityError extends Data.TaggedError('NoCapacityError')<{
  readonly message: string
}> {}

export class ForkDepthExceededError extends Data.TaggedError('ForkDepthExceededError')<{
  readonly message: string
}> {}

export class ForkLimitExceededError extends Data.TaggedError('ForkLimitExceededError')<{
  readonly message: string
}> {}

export class QuotaExceededError extends Data.TaggedError('QuotaExceededError')<{
  readonly message: string
}> {}

export class GoneError extends Data.TaggedError('GoneError')<{
  readonly message: string
}> {}

export class NotImplementedError extends Data.TaggedError('NotImplementedError')<{
  readonly message: string
}> {}

export type ApiError =
  | NotFoundError
  | UnauthorizedError
  | ForbiddenError
  | ValidationError
  | ConflictError
  | RateLimitedError
  | SandboxNotRunningError
  | NoCapacityError
  | ForkDepthExceededError
  | ForkLimitExceededError
  | QuotaExceededError
  | GoneError
  | NotImplementedError

const STATUS_MAP: Record<ApiError['_tag'], number> = {
  NotFoundError: 404,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  ValidationError: 400,
  ConflictError: 409,
  RateLimitedError: 429,
  SandboxNotRunningError: 409,
  NoCapacityError: 503,
  ForkDepthExceededError: 422,
  ForkLimitExceededError: 422,
  QuotaExceededError: 429,
  GoneError: 410,
  NotImplementedError: 501,
}

const CODE_MAP: Record<ApiError['_tag'], string> = {
  NotFoundError: 'not_found',
  UnauthorizedError: 'unauthorized',
  ForbiddenError: 'forbidden',
  ValidationError: 'validation_error',
  ConflictError: 'conflict',
  RateLimitedError: 'rate_limited',
  SandboxNotRunningError: 'sandbox_not_running',
  NoCapacityError: 'no_capacity',
  ForkDepthExceededError: 'fork_depth_exceeded',
  ForkLimitExceededError: 'fork_limit_exceeded',
  QuotaExceededError: 'quota_exceeded',
  GoneError: 'gone',
  NotImplementedError: 'not_implemented',
}

export function errorToResponse(error: ApiError, requestId: string) {
  return HttpServerResponse.unsafeJson(
    {
      error: CODE_MAP[error._tag],
      message: error.message,
      request_id: requestId,
      retry_after: error._tag === 'RateLimitedError' ? error.retryAfter : null,
    },
    {
      status: STATUS_MAP[error._tag],
      headers: { 'content-type': 'application/json' },
    },
  )
}

/** Formats any error as an API error response. Handles both ApiError and unknown errors. */
export function formatApiError(error: unknown, requestId: string = '') {
  const tag =
    typeof error === 'object' && error !== null && '_tag' in error
      ? (error as { _tag: string })._tag
      : null
  if (tag !== null && tag in STATUS_MAP) {
    return errorToResponse(error as ApiError, requestId)
  }
  return HttpServerResponse.unsafeJson(
    {
      error: 'internal_error',
      message: 'An unexpected error occurred',
      request_id: requestId,
      retry_after: null,
    },
    { status: 500, headers: { 'content-type': 'application/json' } },
  )
}
