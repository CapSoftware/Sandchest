/** Machine-readable error codes. */
export type SdkErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'sandbox_not_running'
  | 'validation_error'
  | 'internal_error'
  | 'service_unavailable'

/** Base error for all Sandchest SDK errors. */
export class SandchestError extends Error {
  readonly code: SdkErrorCode
  readonly status: number
  readonly requestId: string

  constructor(opts: { code: SdkErrorCode; message: string; status: number; requestId: string }) {
    super(opts.message)
    this.name = 'SandchestError'
    this.code = opts.code
    this.status = opts.status
    this.requestId = opts.requestId
  }
}

/** Resource not found (HTTP 404). */
export class NotFoundError extends SandchestError {
  constructor(opts: { message: string; requestId: string }) {
    super({ code: 'not_found', message: opts.message, status: 404, requestId: opts.requestId })
    this.name = 'NotFoundError'
  }
}

/** Rate limited (HTTP 429). */
export class RateLimitError extends SandchestError {
  readonly retryAfter: number

  constructor(opts: { message: string; requestId: string; retryAfter: number }) {
    super({
      code: 'rate_limited',
      message: opts.message,
      status: 429,
      requestId: opts.requestId,
    })
    this.name = 'RateLimitError'
    this.retryAfter = opts.retryAfter
  }
}

/** Sandbox is not in a valid state for the requested operation (HTTP 409). */
export class SandboxNotRunningError extends SandchestError {
  constructor(opts: { message: string; requestId: string }) {
    super({
      code: 'sandbox_not_running',
      message: opts.message,
      status: 409,
      requestId: opts.requestId,
    })
    this.name = 'SandboxNotRunningError'
  }
}

/** Validation error — bad request body or parameters (HTTP 400). */
export class ValidationError extends SandchestError {
  constructor(opts: { message: string; requestId: string }) {
    super({
      code: 'validation_error',
      message: opts.message,
      status: 400,
      requestId: opts.requestId,
    })
    this.name = 'ValidationError'
  }
}

/** Authentication failed — missing or invalid API key (HTTP 401). */
export class AuthenticationError extends SandchestError {
  constructor(opts: { message: string; requestId: string }) {
    super({
      code: 'unauthorized',
      message: opts.message,
      status: 401,
      requestId: opts.requestId,
    })
    this.name = 'AuthenticationError'
  }
}
