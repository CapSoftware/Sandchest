import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { formatRelativeTime, formatShortDate } from './format'

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
