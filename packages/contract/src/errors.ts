/** Standard API error response envelope. */
export interface ApiError {
  error: string
  message: string
  request_id: string
  retry_after: number | null
}

/** Machine-readable error codes used in the `error` field. */
export type ErrorCode =
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
