import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { formatRelativeTime, formatShortDate, formatDuration, formatCmd, formatBytes } from './format'

describe('formatRelativeTime', () => {
  let realDate: typeof Date

  beforeEach(() => {
    realDate = globalThis.Date
  })

  afterEach(() => {
    globalThis.Date = realDate
  })

  function mockNow(now: Date) {
    const OrigDate = realDate
    globalThis.Date = class extends OrigDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(now.getTime())
        } else {
          // @ts-expect-error -- forwarding variadic args to Date constructor
          super(...args)
        }
      }
    } as typeof Date
    globalThis.Date.now = () => now.getTime()
  }

  test('returns "just now" for timestamps less than a minute ago', () => {
    const now = new Date('2025-06-15T12:00:00Z')
    mockNow(now)
    expect(formatRelativeTime('2025-06-15T12:00:00Z')).toBe('just now')
    expect(formatRelativeTime('2025-06-15T11:59:30Z')).toBe('just now')
  })

  test('returns minutes for timestamps under an hour ago', () => {
    const now = new Date('2025-06-15T12:00:00Z')
    mockNow(now)
    expect(formatRelativeTime('2025-06-15T11:55:00Z')).toBe('5m ago')
    expect(formatRelativeTime('2025-06-15T11:01:00Z')).toBe('59m ago')
  })

  test('returns hours for timestamps under a day ago', () => {
    const now = new Date('2025-06-15T12:00:00Z')
    mockNow(now)
    expect(formatRelativeTime('2025-06-15T10:00:00Z')).toBe('2h ago')
    expect(formatRelativeTime('2025-06-14T13:00:00Z')).toBe('23h ago')
  })

  test('returns days for timestamps over a day ago', () => {
    const now = new Date('2025-06-15T12:00:00Z')
    mockNow(now)
    expect(formatRelativeTime('2025-06-14T11:00:00Z')).toBe('1d ago')
    expect(formatRelativeTime('2025-06-08T12:00:00Z')).toBe('7d ago')
  })
})

describe('formatShortDate', () => {
  test('formats a date to short format', () => {
    const result = formatShortDate(new Date('2025-01-15'))
    expect(result).toContain('Jan')
    expect(result).toContain('2025')
  })

  test('handles different months', () => {
    const result = formatShortDate(new Date('2025-12-25'))
    expect(result).toContain('Dec')
    expect(result).toContain('25')
    expect(result).toContain('2025')
  })
})

describe('formatDuration', () => {
  test('formats sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(50)).toBe('50ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  test('formats seconds with one decimal place', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(59999)).toBe('60.0s')
  })

  test('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
    expect(formatDuration(90000)).toBe('1m 30s')
    expect(formatDuration(3600000)).toBe('60m 0s')
  })
})

describe('formatCmd', () => {
  test('returns string commands as-is', () => {
    expect(formatCmd('ls -la')).toBe('ls -la')
    expect(formatCmd('echo hello')).toBe('echo hello')
  })

  test('joins array commands with spaces', () => {
    expect(formatCmd(['ls', '-la'])).toBe('ls -la')
    expect(formatCmd(['echo', 'hello', 'world'])).toBe('echo hello world')
  })

  test('handles empty array', () => {
    expect(formatCmd([])).toBe('')
  })

  test('handles single-element array', () => {
    expect(formatCmd(['ls'])).toBe('ls')
  })
})

describe('formatBytes', () => {
  test('formats bytes', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(1023)).toBe('1023B')
  })

  test('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0KB')
    expect(formatBytes(1536)).toBe('1.5KB')
    expect(formatBytes(1048575)).toBe('1024.0KB')
  })

  test('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0MB')
    expect(formatBytes(5242880)).toBe('5.0MB')
  })

  test('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0GB')
    expect(formatBytes(2147483648)).toBe('2.0GB')
  })
})
