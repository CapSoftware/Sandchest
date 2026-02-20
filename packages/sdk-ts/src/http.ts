import {
  SandchestError,
  NotFoundError,
  RateLimitError,
  SandboxNotRunningError,
  AuthenticationError,
  ValidationError,
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

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelay(attempt - 1))
      }

      try {
        const controller = new AbortController()
        const timeoutMs = options.timeout ?? this.timeout
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
          return (await response.json()) as T
        }

        const errorBody = (await response.json().catch(() => null)) as ApiErrorBody | null
        const requestId = errorBody?.request_id ?? response.headers.get('x-request-id') ?? ''
        const message = errorBody?.message ?? `HTTP ${response.status}`

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
          throw error
        }

        if (attempt < this.retries) {
          lastError = error instanceof Error ? error : new Error(String(error))
          continue
        }

        throw lastError ?? error
      }
    }

    throw lastError ?? new Error('Request failed after retries')
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
