import { describe, expect, test } from 'bun:test'
import { normalizeApiKeyVerificationError } from './middleware.js'

describe('normalizeApiKeyVerificationError', () => {
  test('maps Better Auth rate limit errors to RateLimitedError', () => {
    const error = normalizeApiKeyVerificationError({
      statusCode: 401,
      body: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded.',
        details: {
          retryAfter: 17,
        },
      },
      headers: {},
    })

    expect(error._tag).toBe('RateLimitedError')
    expect(error.message).toBe('Rate limit exceeded.')
    expect('retryAfter' in error ? error.retryAfter : null).toBe(17)
  })

  test('falls back to UnauthorizedError for non-rate-limit failures', () => {
    const error = normalizeApiKeyVerificationError({
      statusCode: 401,
      body: {
        code: 'UNAUTHORIZED',
        message: 'Invalid API key',
      },
      headers: {},
    })

    expect(error._tag).toBe('UnauthorizedError')
    expect(error.message).toBe('Invalid API key')
  })

  test('maps nested Better Auth rate limit errors to RateLimitedError', () => {
    const error = normalizeApiKeyVerificationError(
      new Error('Failed to validate API key: APIError: Rate limit exceeded.', {
        cause: {
          statusCode: 401,
          body: {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded.',
            details: {
              retry_after: 9,
            },
          },
          headers: {},
        },
      }),
    )

    expect(error._tag).toBe('RateLimitedError')
    expect(error.message).toBe('Rate limit exceeded.')
    expect('retryAfter' in error ? error.retryAfter : null).toBe(9)
  })

  test('maps message-only rate limit errors to RateLimitedError', () => {
    const error = normalizeApiKeyVerificationError(
      new Error('Failed to validate API key: APIError: Rate limit exceeded.'),
    )

    expect(error._tag).toBe('RateLimitedError')
    expect(error.message).toBe('Rate limit exceeded.')
    expect('retryAfter' in error ? error.retryAfter : null).toBe(60)
  })
})
