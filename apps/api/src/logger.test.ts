import { Effect, HashMap, Layer, List, Logger, LogLevel } from 'effect'
import { describe, expect, test } from 'bun:test'

/** Creates a capture logger that records JSON lines for assertions. */
function createCaptureLogger() {
  const lines: string[] = []

  const layer = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message, date, annotations, spans }) => {
      const msg = Array.isArray(message)
        ? message.length === 1
          ? String(message[0])
          : message.map(String).join(' ')
        : String(message)

      const entry: Record<string, unknown> = {
        level: logLevel.label.toLowerCase(),
        ts: date.toISOString(),
        msg,
      }

      if (HashMap.size(annotations) > 0) {
        for (const [key, value] of HashMap.toEntries(annotations)) {
          entry[key] = value
        }
      }

      if (!List.isNil(spans)) {
        entry['spans'] = List.toArray(spans).map((s) => s.label)
      }

      lines.push(JSON.stringify(entry))
    }),
  ).pipe(Layer.merge(Logger.minimumLogLevel(LogLevel.Info)))

  return { lines, layer }
}

describe('JsonLoggerLive', () => {
  test('produces valid JSON with level, ts, and msg fields', async () => {
    const { lines, layer } = createCaptureLogger()

    await Effect.log('test message').pipe(
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('test message')
    expect(parsed.ts).toBeDefined()
    expect(() => new Date(parsed.ts as string)).not.toThrow()
  })

  test('includes annotations in JSON output', async () => {
    const { lines, layer } = createCaptureLogger()

    await Effect.log('annotated').pipe(
      Effect.annotateLogs('requestId', 'req_123'),
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.msg).toBe('annotated')
    expect(parsed.requestId).toBe('req_123')
  })

  test('includes log spans in JSON output', async () => {
    const { lines, layer } = createCaptureLogger()

    await Effect.log('spanned').pipe(
      Effect.withLogSpan('myOperation'),
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.spans).toEqual(['myOperation'])
  })

  test('filters out debug messages at Info level', async () => {
    const { lines, layer } = createCaptureLogger()

    await Effect.logDebug('should be filtered').pipe(
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(lines.length).toBe(0)
  })

  test('maps different log levels correctly', async () => {
    const { lines, layer } = createCaptureLogger()

    await Effect.gen(function* () {
      yield* Effect.logInfo('info msg')
      yield* Effect.logWarning('warn msg')
      yield* Effect.logError('error msg')
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(lines.length).toBe(3)
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level)
    expect(levels).toEqual(['info', 'warn', 'error'])
  })
})
