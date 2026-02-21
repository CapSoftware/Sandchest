import type { ExecStreamEvent } from '@sandchest/contract'
import type { ExecResult } from './types.js'

/** Parse SSE events from a streaming Response. */
export async function* parseSSE<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()!

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data) {
              yield JSON.parse(data) as T
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * A streaming exec result. Implements AsyncIterable so you can
 * `for await` over events, or call `collect()` to wait for the full result.
 *
 * Single-use: the underlying stream is consumed on first iteration.
 */
export class ExecStream implements AsyncIterable<ExecStreamEvent> {
  readonly execId: string
  private readonly _generator: AsyncGenerator<ExecStreamEvent>

  /** @internal — Use `sandbox.exec(cmd, { stream: true })` instead. */
  constructor(execId: string, generator: AsyncGenerator<ExecStreamEvent>) {
    this.execId = execId
    this._generator = generator
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecStreamEvent> {
    return this._generator
  }

  /** Consume the entire stream and return the aggregated ExecResult. */
  async collect(): Promise<ExecResult> {
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    let durationMs = 0

    for await (const event of this) {
      switch (event.t) {
        case 'stdout':
          stdout += event.data
          break
        case 'stderr':
          stderr += event.data
          break
        case 'exit':
          exitCode = event.code
          durationMs = event.duration_ms
          break
      }
    }

    return { execId: this.execId, exitCode, stdout, stderr, durationMs }
  }
}
