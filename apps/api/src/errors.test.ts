import { describe, expect, test } from 'bun:test'
import {
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  RateLimitedError,
  SandboxNotRunningError,
  NoCapacityError,
  NotImplementedError,
  errorToResponse,
  formatApiError,
} from './errors.js'

function extractBody(response: { body: unknown }): Record<string, unknown> {
  // HttpServerResponse.unsafeJson wraps the body in an HttpBody envelope
  // The actual JSON is at response.body.body as a Uint8Array
  const envelope = response.body as { body: Uint8Array }
  return JSON.parse(new TextDecoder().decode(envelope.body)) as Record<string, unknown>
}

function extractStatus(response: { status: number }): number {
  return response.status
}

// ---------------------------------------------------------------------------
// errorToResponse — maps typed ApiError to HTTP response
// ---------------------------------------------------------------------------

describe('errorToResponse', () => {
  test('NotFoundError maps to 404 with not_found code', () => {
    const error = new NotFoundError({ message: 'Sandbox sb_123 not found' })
    const response = errorToResponse(error, 'req_abc')
    const body = extractBody(response)
    expect(extractStatus(response)).toBe(404)
    expect(body.error).toBe('not_found')
    expect(body.message).toBe('Sandbox sb_123 not found')
    expect(body.request_id).toBe('req_abc')
    expect(body.retry_after).toBeNull()
  })

  test('UnauthorizedError maps to 401 with unauthorized code', () => {
    const error = new UnauthorizedError({ message: 'Invalid API key' })
    const response = errorToResponse(error, 'req_def')
    const body = extractBody(response)
    expect(extractStatus(response)).toBe(401)
    expect(body.error).toBe('unauthorized')
    expect(body.message).toBe('Invalid API key')
    expect(body.request_id).toBe('req_def')
  })

  test('ForbiddenError maps to 403 with forbidden code', () => {
    const error = new ForbiddenError({ message: 'Insufficient permissions' })
    const response = errorToResponse(error, 'req_ghi')
    expect(extractStatus(response)).toBe(403)
    expect(extractBody(response).error).toBe('forbidden')
  })

  test('ValidationError maps to 400 with validation_error code', () => {
    const error = new ValidationError({ message: 'Invalid profile: xlarge' })
    const response = errorToResponse(error, 'req_jkl')
    expect(extractStatus(response)).toBe(400)
    expect(extractBody(response).error).toBe('validation_error')
  })

  test('ConflictError maps to 409 with conflict code', () => {
    const error = new ConflictError({ message: 'Max sessions exceeded' })
    const response = errorToResponse(error, 'req_mno')
    expect(extractStatus(response)).toBe(409)
    expect(extractBody(response).error).toBe('conflict')
  })

  test('RateLimitedError maps to 429 with retry_after', () => {
    const error = new RateLimitedError({ message: 'Rate limit exceeded', retryAfter: 30 })
    const response = errorToResponse(error, 'req_pqr')
    const body = extractBody(response)
    expect(extractStatus(response)).toBe(429)
    expect(body.error).toBe('rate_limited')
    expect(body.retry_after).toBe(30)
  })

  test('SandboxNotRunningError maps to 409 with sandbox_not_running code', () => {
    const error = new SandboxNotRunningError({
      message: 'Sandbox sb_123 is not in running state (current: stopped)',
    })
    const response = errorToResponse(error, 'req_stu')
    expect(extractStatus(response)).toBe(409)
    expect(extractBody(response).error).toBe('sandbox_not_running')
  })

  test('NoCapacityError maps to 503 with no_capacity code', () => {
    const error = new NoCapacityError({ message: 'All nodes at capacity' })
    const response = errorToResponse(error, 'req_vwx')
    expect(extractStatus(response)).toBe(503)
    expect(extractBody(response).error).toBe('no_capacity')
  })

  test('NotImplementedError maps to 501 with not_implemented code', () => {
    const error = new NotImplementedError({ message: 'Fork not yet implemented' })
    const response = errorToResponse(error, 'req_yza')
    expect(extractStatus(response)).toBe(501)
    expect(extractBody(response).error).toBe('not_implemented')
  })

  test('response includes request_id in body', () => {
    const error = new NotFoundError({ message: 'Not found' })
    const response = errorToResponse(error, 'req_custom_id_123')
    expect(extractBody(response).request_id).toBe('req_custom_id_123')
  })

  test('non-RateLimitedError errors have null retry_after', () => {
    const errors = [
      new NotFoundError({ message: 'x' }),
      new UnauthorizedError({ message: 'x' }),
      new ForbiddenError({ message: 'x' }),
      new ValidationError({ message: 'x' }),
      new ConflictError({ message: 'x' }),
      new SandboxNotRunningError({ message: 'x' }),
      new NoCapacityError({ message: 'x' }),
      new NotImplementedError({ message: 'x' }),
    ]
    for (const error of errors) {
      const response = errorToResponse(error, 'req')
      expect(extractBody(response).retry_after).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// formatApiError — handles both ApiError and unknown errors
// ---------------------------------------------------------------------------

describe('formatApiError', () => {
  test('formats known ApiError correctly', () => {
    const error = new NotFoundError({ message: 'Not found' })
    const response = formatApiError(error, 'req_123')
    expect(extractStatus(response)).toBe(404)
    expect(extractBody(response).error).toBe('not_found')
  })

  test('formats unknown error as 500 internal_error', () => {
    const response = formatApiError(new Error('kaboom'), 'req_456')
    const body = extractBody(response)
    expect(extractStatus(response)).toBe(500)
    expect(body.error).toBe('internal_error')
    expect(body.message).toBe('An unexpected error occurred')
    expect(body.request_id).toBe('req_456')
    expect(body.retry_after).toBeNull()
  })

  test('formats string error as 500 internal_error', () => {
    const response = formatApiError('something went wrong', 'req_789')
    expect(extractStatus(response)).toBe(500)
    expect(extractBody(response).error).toBe('internal_error')
  })

  test('formats null error as 500 internal_error', () => {
    const response = formatApiError(null, 'req_abc')
    expect(extractStatus(response)).toBe(500)
    expect(extractBody(response).error).toBe('internal_error')
  })

  test('formats undefined error as 500 internal_error', () => {
    const response = formatApiError(undefined, 'req_def')
    expect(extractStatus(response)).toBe(500)
  })

  test('formats object with unknown _tag as 500 internal_error', () => {
    const response = formatApiError({ _tag: 'UnknownTag', message: 'bad' }, 'req_ghi')
    expect(extractStatus(response)).toBe(500)
    expect(extractBody(response).error).toBe('internal_error')
  })

  test('uses empty string as default requestId', () => {
    const response = formatApiError(new Error('oops'))
    expect(extractBody(response).request_id).toBe('')
  })

  test('does not leak internal error details to caller', () => {
    const sensitiveError = new Error('MYSQL_PASSWORD=hunter2 connection failed')
    const response = formatApiError(sensitiveError, 'req_secure')
    const body = extractBody(response)
    expect(body.message).toBe('An unexpected error occurred')
    expect(body.message).not.toContain('hunter2')
    expect(body.message).not.toContain('MYSQL_PASSWORD')
  })
})
