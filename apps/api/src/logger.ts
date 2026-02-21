import { HashMap, Layer, List, Logger, LogLevel } from 'effect'

/** Structured JSON logger that outputs one JSON object per line to stdout. */
export const JsonLoggerLive = Logger.replace(
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

    process.stdout.write(JSON.stringify(entry) + '\n')
  }),
).pipe(Layer.merge(Logger.minimumLogLevel(LogLevel.Info)))
