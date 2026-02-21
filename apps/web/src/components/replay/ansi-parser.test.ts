import { describe, expect, test } from 'bun:test'
import { parseAnsi, formatElapsed } from './ansi-parser'

describe('parseAnsi', () => {
  test('plain text returns single unstyled segment', () => {
    const result = parseAnsi('hello world')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('hello world')
    expect(result[0]!.bold).toBe(false)
    expect(result[0]!.fg).toBeNull()
    expect(result[0]!.bg).toBeNull()
  })

  test('parses standard foreground colors', () => {
    const result = parseAnsi('\x1b[31mred text\x1b[0m')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('red text')
    expect(result[0]!.fg).toBe('hsl(0, 70%, 60%)')
  })

  test('parses green foreground', () => {
    const result = parseAnsi('\x1b[32mgreen\x1b[0m')
    expect(result[0]!.fg).toBe('hsl(140, 60%, 50%)')
  })

  test('parses bright colors (90-97)', () => {
    const result = parseAnsi('\x1b[92mbright green\x1b[0m')
    expect(result[0]!.text).toBe('bright green')
    expect(result[0]!.fg).toBe('hsl(62, 84%, 88%)')
  })

  test('parses bold attribute', () => {
    const result = parseAnsi('\x1b[1mbold text\x1b[0m')
    expect(result[0]!.bold).toBe(true)
    expect(result[0]!.text).toBe('bold text')
  })

  test('parses dim attribute', () => {
    const result = parseAnsi('\x1b[2mdim text\x1b[0m')
    expect(result[0]!.dim).toBe(true)
  })

  test('parses underline attribute', () => {
    const result = parseAnsi('\x1b[4munderlined\x1b[0m')
    expect(result[0]!.underline).toBe(true)
  })

  test('handles bold + color combined', () => {
    const result = parseAnsi('\x1b[1;33mbold yellow\x1b[0m')
    expect(result[0]!.bold).toBe(true)
    expect(result[0]!.fg).toBe('hsl(45, 80%, 70%)')
  })

  test('resets attributes on SGR 0', () => {
    const result = parseAnsi('\x1b[1;31mred bold\x1b[0m normal')
    expect(result).toHaveLength(2)
    expect(result[0]!.bold).toBe(true)
    expect(result[0]!.fg).toBe('hsl(0, 70%, 60%)')
    expect(result[1]!.bold).toBe(false)
    expect(result[1]!.fg).toBeNull()
    expect(result[1]!.text).toBe(' normal')
  })

  test('handles implicit reset (bare ESC[m)', () => {
    const result = parseAnsi('\x1b[31mred\x1b[m normal')
    expect(result).toHaveLength(2)
    expect(result[1]!.fg).toBeNull()
  })

  test('parses background colors', () => {
    const result = parseAnsi('\x1b[41mred bg\x1b[0m')
    expect(result[0]!.bg).toBe('hsl(0, 40%, 20%)')
  })

  test('parses 256-color foreground (38;5;N)', () => {
    // Color 196 is in the 216-color cube (bright red)
    const result = parseAnsi('\x1b[38;5;196mcolor\x1b[0m')
    expect(result[0]!.fg).not.toBeNull()
    expect(result[0]!.text).toBe('color')
  })

  test('parses 256-color grayscale (38;5;240)', () => {
    const result = parseAnsi('\x1b[38;5;240mgray\x1b[0m')
    expect(result[0]!.fg).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
  })

  test('parses truecolor foreground (38;2;R;G;B)', () => {
    const result = parseAnsi('\x1b[38;2;255;128;0morange\x1b[0m')
    expect(result[0]!.fg).toBe('rgb(255, 128, 0)')
  })

  test('parses truecolor background (48;2;R;G;B)', () => {
    const result = parseAnsi('\x1b[48;2;0;0;128mblue bg\x1b[0m')
    expect(result[0]!.bg).toBe('rgb(0, 0, 128)')
  })

  test('strips non-SGR escape sequences', () => {
    const result = parseAnsi('\x1b[2Jclear screen\x1b[Hcursor home')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('clear screencursor home')
  })

  test('merges adjacent segments with identical styles', () => {
    const result = parseAnsi('\x1b[31mpart1\x1b[31mpart2\x1b[0m')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('part1part2')
  })

  test('handles empty input', () => {
    const result = parseAnsi('')
    expect(result).toHaveLength(0)
  })

  test('handles input with only escape sequences', () => {
    const result = parseAnsi('\x1b[31m\x1b[0m')
    expect(result).toHaveLength(0)
  })

  test('handles multiple colors in sequence', () => {
    const result = parseAnsi('\x1b[31mred\x1b[32mgreen\x1b[34mblue\x1b[0m')
    expect(result).toHaveLength(3)
    expect(result[0]!.text).toBe('red')
    expect(result[0]!.fg).toBe('hsl(0, 70%, 60%)')
    expect(result[1]!.text).toBe('green')
    expect(result[1]!.fg).toBe('hsl(140, 60%, 50%)')
    expect(result[2]!.text).toBe('blue')
    expect(result[2]!.fg).toBe('hsl(210, 50%, 60%)')
  })

  test('resets specific attributes without full reset', () => {
    const result = parseAnsi('\x1b[1;4mbold underline\x1b[22mnot bold\x1b[24mnormal\x1b[0m')
    expect(result).toHaveLength(3)
    expect(result[0]!.bold).toBe(true)
    expect(result[0]!.underline).toBe(true)
    expect(result[1]!.bold).toBe(false)
    expect(result[1]!.underline).toBe(true)
    expect(result[2]!.bold).toBe(false)
    expect(result[2]!.underline).toBe(false)
  })

  test('handles default fg (39) and default bg (49)', () => {
    const result = parseAnsi('\x1b[31;41mcolored\x1b[39mdefault fg\x1b[49mdefault bg')
    expect(result).toHaveLength(3)
    expect(result[0]!.fg).toBe('hsl(0, 70%, 60%)')
    expect(result[0]!.bg).toBe('hsl(0, 40%, 20%)')
    expect(result[1]!.fg).toBeNull()
    expect(result[1]!.bg).toBe('hsl(0, 40%, 20%)')
    expect(result[2]!.fg).toBeNull()
    expect(result[2]!.bg).toBeNull()
  })
})

describe('formatElapsed', () => {
  test('returns 00:00 for same timestamp', () => {
    const ts = '2026-01-01T00:00:00.000Z'
    expect(formatElapsed(ts, ts)).toBe('00:00')
  })

  test('formats seconds', () => {
    expect(
      formatElapsed('2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z'),
    ).toBe('00:30')
  })

  test('formats minutes and seconds', () => {
    expect(
      formatElapsed('2026-01-01T00:00:00Z', '2026-01-01T00:05:15Z'),
    ).toBe('05:15')
  })

  test('formats hours', () => {
    expect(
      formatElapsed('2026-01-01T00:00:00Z', '2026-01-01T01:30:05Z'),
    ).toBe('1:30:05')
  })

  test('handles event before start (returns 00:00)', () => {
    expect(
      formatElapsed('2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z'),
    ).toBe('00:00')
  })
})
