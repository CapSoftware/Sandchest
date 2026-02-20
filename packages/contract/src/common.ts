/** Cursor-based pagination parameters for list endpoints. */
export interface PaginationParams {
  cursor?: string | undefined
  limit?: number | undefined
}

/** Paginated response wrapper. */
export interface PaginatedResponse<T> {
  items: T[]
  next_cursor: string | null
}

/** CPU and memory usage reported by the guest agent. */
export interface ResourceUsage {
  cpu_ms: number
  peak_memory_bytes: number
}
