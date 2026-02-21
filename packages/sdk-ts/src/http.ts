import {
  SandchestError,
  NotFoundError,
  RateLimitError,
  SandboxNotRunningError,
  AuthenticationError,
  ValidationError,
  TimeoutError,
  ConnectionError,
} from './errors.js'
import type { SdkErrorCode } from './errors.js'

/** Shape of the API error response body. */
interface ApiErrorBody {
  error: string
  message: string
  request_id: string
  retry_after: number | null
}

export interface HttpClientOptions {
  apiKey: string
  baseUrl: string
  timeout: number
  retries: number
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  timeout?: number | undefined
  idempotencyKey?: string | undefined
}

/** Generate a random idempotency key for mutation requests. */
function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Maximum time to wait on a 429 retry_after value (60 seconds). */
const MAX_RATE_LIMIT_WAIT_MS = 60_000

/** Add jitter to a delay for exponential backoff. */
function backoffDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000)
  const jitter = Math.random() * base * 0.5
  return base + jitter
}

/**
 * Internal HTTP client for the Sandchest SDK.
 * Handles authentication, retries, error parsing, and idempotency.
 */
export class HttpClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeout: number
  private readonly retries: number

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.timeout = options.timeout
    this.retries = options.retries
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query)
    const isMutation = options.method !== 'GET'
    const idempotencyKey =
      isMutation ? (options.idempotencyKey ?? generateIdempotencyKey()) : undefined

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey
    }

    const timeoutMs = options.timeout ?? this.timeout
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0 && lastError) {
        const delay =
          lastError instanceof RateLimitError
            ? Math.min(lastError.retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : backoffDelay(attempt - 1)
        await sleep(delay)
      }

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        const fetchInit: RequestInit = {
          method: options.method,
          headers,
          signal: controller.signal,
        }

        if (options.body !== undefined) {
          fetchInit.body = JSON.stringify(options.body)
        }

        const response = await fetch(url, fetchInit)

        clearTimeout(timer)

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T
          }
          return (await response.json()) as T
        }

        const errorBody = (await response.json().catch(() => null)) as ApiErrorBody | null
        const requestId = errorBody?.request_id ?? response.headers.get('x-request-id') ?? ''
        const message = errorBody?.message ?? `HTTP ${response.status}`

        if (response.status === 429 && attempt < this.retries) {
          lastError = new RateLimitError({
            message,
            requestId,
            retryAfter: errorBody?.retry_after ?? 1,
          })
          continue
        }

        if (response.status >= 500 && attempt < this.retries) {
          lastError = new SandchestError({
            code: 'internal_error',
            message,
            status: response.status,
            requestId,
          })
          continue
        }

        throw this.parseErrorResponse(response.status, message, requestId, errorBody)
      } catch (error) {
        if (error instanceof SandchestError) {
          if (error instanceof RateLimitError && attempt < this.retries) {
            lastError = error
            continue
          }
          throw error
        }

        if (attempt < this.retries) {
          lastError = error instanceof Error ? error : new Error(String(error))
          continue
        }

        const raw = lastError ?? error
        throw this.wrapRawError(raw, timeoutMs)
      }
    }

    throw this.wrapRawError(lastError, timeoutMs)
  }

  /** Wrap non-SDK errors into typed TimeoutError or ConnectionError. */
  private wrapRawError(error: unknown, timeoutMs: number): SandchestError {
    if (error instanceof SandchestError) {
      return error
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return new TimeoutError({
        message: `Request timed out after ${timeoutMs}ms`,
        timeoutMs,
      })
    }

    const cause = error instanceof Error ? error : new Error(String(error))
    return new ConnectionError({
      message: cause.message || 'Network request failed',
      cause,
    })
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(path, this.baseUrl)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value))
        }
      }
    }
    return url.toString()
  }

  private parseErrorResponse(
    status: number,
    message: string,
    requestId: string,
    errorBody: ApiErrorBody | null,
  ): SandchestError {
    switch (status) {
      case 400:
        return new ValidationError({ message, requestId })
      case 401:
        return new AuthenticationError({ message, requestId })
      case 404:
        return new NotFoundError({ message, requestId })
      case 409:
        return new SandboxNotRunningError({ message, requestId })
      case 429:
        return new RateLimitError({
          message,
          requestId,
          retryAfter: errorBody?.retry_after ?? 1,
        })
      default:
        return new SandchestError({
          code: (errorBody?.error as SdkErrorCode) ?? 'internal_error',
          message,
          status,
          requestId,
        })
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
