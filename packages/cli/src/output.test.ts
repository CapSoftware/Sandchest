import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { formatAge, statusColor, success, error, info, printJson } from './output.js'

describe('output', () => {
  const originalNoColor = process.env['NO_COLOR']

  beforeEach(() => {
    process.env['NO_COLOR'] = '1'
  })

  afterEach(() => {
    if (originalNoColor !== undefined) {
      process.env['NO_COLOR'] = originalNoColor
    } else {
      delete process.env['NO_COLOR']
    }
  })

  describe('formatAge', () => {
    test('formats seconds', () => {
      const now = new Date()
      now.setSeconds(now.getSeconds() - 30)
      expect(formatAge(now.toISOString())).toBe('30s')
    })

    test('formats minutes', () => {
      const now = new Date()
      now.setMinutes(now.getMinutes() - 5)
      expect(formatAge(now.toISOString())).toBe('5m')
    })

    test('formats hours', () => {
      const now = new Date()
      now.setHours(now.getHours() - 3)
      expect(formatAge(now.toISOString())).toBe('3h')
    })

    test('formats days', () => {
      const now = new Date()
      now.setDate(now.getDate() - 7)
      expect(formatAge(now.toISOString())).toBe('7d')
    })
  })

  describe('statusColor', () => {
    test('returns the status string for known statuses', () => {
      expect(statusColor('running')).toContain('running')
      expect(statusColor('queued')).toContain('queued')
      expect(statusColor('stopped')).toContain('stopped')
      expect(statusColor('failed')).toContain('failed')
    })

    test('returns unmodified string for unknown status', () => {
      expect(statusColor('unknown')).toBe('unknown')
    })
  })

  describe('success', () => {
    test('prints message to stdout', () => {
      const spy = spyOn(console, 'log').mockImplementation(() => {})
      success('it worked')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('it worked'))
      spy.mockRestore()
    })
  })

  describe('error', () => {
    test('prints message to stderr', () => {
      const spy = spyOn(console, 'error').mockImplementation(() => {})
      error('it failed')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('it failed'))
      spy.mockRestore()
    })
  })

  describe('info', () => {
    test('prints message to stdout', () => {
      const spy = spyOn(console, 'log').mockImplementation(() => {})
      info('some info')
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('some info'))
      spy.mockRestore()
    })
  })

  describe('printJson', () => {
    test('prints formatted JSON', () => {
      const spy = spyOn(console, 'log').mockImplementation(() => {})
      printJson({ foo: 'bar' })
      expect(spy).toHaveBeenCalledWith(JSON.stringify({ foo: 'bar' }, null, 2))
      spy.mockRestore()
    })
  })
})
