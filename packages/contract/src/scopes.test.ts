import { describe, test, expect } from 'bun:test'
import { API_KEY_SCOPES, ALL_SCOPES, isValidScope, parseScopes } from './scopes.js'

describe('API key scopes', () => {
  test('ALL_SCOPES matches API_KEY_SCOPES', () => {
    expect(ALL_SCOPES).toEqual(API_KEY_SCOPES)
  })

  test('isValidScope returns true for known scopes', () => {
    expect(isValidScope('sandbox:create')).toBe(true)
    expect(isValidScope('exec:read')).toBe(true)
    expect(isValidScope('file:write')).toBe(true)
    expect(isValidScope('artifact:read')).toBe(true)
  })

  test('isValidScope returns false for unknown strings', () => {
    expect(isValidScope('invalid')).toBe(false)
    expect(isValidScope('sandbox:admin')).toBe(false)
    expect(isValidScope('')).toBe(false)
    expect(isValidScope('*')).toBe(false)
  })

  test('parseScopes filters out unknown scopes', () => {
    const result = parseScopes(['sandbox:create', 'invalid', 'exec:read', ''])
    expect(result).toEqual(['sandbox:create', 'exec:read'])
  })

  test('parseScopes returns empty array for all-invalid input', () => {
    expect(parseScopes(['nope', 'bad'])).toEqual([])
  })

  test('parseScopes returns all valid scopes when all are valid', () => {
    const all = [...API_KEY_SCOPES]
    expect(parseScopes(all)).toEqual(all)
  })

  test('every scope follows resource:action pattern', () => {
    for (const scope of API_KEY_SCOPES) {
      expect(scope).toMatch(/^[a-z]+:(create|read|write)$/)
    }
  })
})
