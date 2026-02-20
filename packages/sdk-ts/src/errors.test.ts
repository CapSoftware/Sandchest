import { describe, test, expect } from 'bun:test'
import {
  SandchestError,
  NotFoundError,
  RateLimitError,
  SandboxNotRunningError,
  ValidationError,
  AuthenticationError,
} from './errors.js'

describe('SandchestError', () => {
  test('stores code, status, requestId, and message', () => {
    const err = new SandchestError({
      code: 'internal_error',
      message: 'Something went wrong',
      status: 500,
      requestId: 'req_abc123',
    })

    expect(err.code).toBe('internal_error')
    expect(err.status).toBe(500)
    expect(err.requestId).toBe('req_abc123')
    expect(err.message).toBe('Something went wrong')
    expect(err.name).toBe('SandchestError')
  })

  test('extends Error', () => {
    const err = new SandchestError({
      code: 'internal_error',
      message: 'fail',
      status: 500,
      requestId: 'req_1',
    })
    expect(err).toBeInstanceOf(Error)
  })
})

describe('NotFoundError', () => {
  test('sets status 404 and code not_found', () => {
    const err = new NotFoundError({ message: 'Sandbox not found', requestId: 'req_2' })
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
    expect(err.name).toBe('NotFoundError')
    expect(err.message).toBe('Sandbox not found')
  })

  test('is instanceof SandchestError', () => {
    const err = new NotFoundError({ message: 'gone', requestId: 'req_3' })
    expect(err).toBeInstanceOf(SandchestError)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('RateLimitError', () => {
  test('sets status 429, code rate_limited, and retryAfter', () => {
    const err = new RateLimitError({
      message: 'Too many requests',
      requestId: 'req_4',
      retryAfter: 30,
    })
    expect(err.status).toBe(429)
    expect(err.code).toBe('rate_limited')
    expect(err.name).toBe('RateLimitError')
    expect(err.retryAfter).toBe(30)
  })

  test('is instanceof SandchestError', () => {
    const err = new RateLimitError({ message: 'slow down', requestId: 'req_5', retryAfter: 1 })
    expect(err).toBeInstanceOf(SandchestError)
  })
})

describe('SandboxNotRunningError', () => {
  test('sets status 409 and code sandbox_not_running', () => {
    const err = new SandboxNotRunningError({
      message: 'Sandbox is stopped',
      requestId: 'req_6',
    })
    expect(err.status).toBe(409)
    expect(err.code).toBe('sandbox_not_running')
    expect(err.name).toBe('SandboxNotRunningError')
  })

  test('is instanceof SandchestError', () => {
    const err = new SandboxNotRunningError({ message: 'not running', requestId: 'req_7' })
    expect(err).toBeInstanceOf(SandchestError)
  })
})

describe('ValidationError', () => {
  test('sets status 400 and code validation_error', () => {
    const err = new ValidationError({ message: 'Invalid body', requestId: 'req_8' })
    expect(err.status).toBe(400)
    expect(err.code).toBe('validation_error')
    expect(err.name).toBe('ValidationError')
  })

  test('is instanceof SandchestError', () => {
    const err = new ValidationError({ message: 'bad', requestId: 'req_9' })
    expect(err).toBeInstanceOf(SandchestError)
  })
})

describe('AuthenticationError', () => {
  test('sets status 401 and code unauthorized', () => {
    const err = new AuthenticationError({ message: 'Invalid API key', requestId: 'req_10' })
    expect(err.status).toBe(401)
    expect(err.code).toBe('unauthorized')
    expect(err.name).toBe('AuthenticationError')
  })

  test('is instanceof SandchestError', () => {
    const err = new AuthenticationError({ message: 'unauthed', requestId: 'req_11' })
    expect(err).toBeInstanceOf(SandchestError)
  })
})
