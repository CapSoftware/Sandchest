import { describe, expect, test } from 'bun:test'
import { isValidEmail, isValidOtp } from './validation'

describe('isValidEmail', () => {
  test('accepts valid email addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true)
    expect(isValidEmail('name@company.co')).toBe(true)
    expect(isValidEmail('test+tag@mail.org')).toBe(true)
    expect(isValidEmail('hello@sub.domain.com')).toBe(true)
  })

  test('trims whitespace before validating', () => {
    expect(isValidEmail('  user@example.com  ')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false)
  })

  test('rejects strings without @', () => {
    expect(isValidEmail('userexample.com')).toBe(false)
  })

  test('rejects strings without domain', () => {
    expect(isValidEmail('user@')).toBe(false)
    expect(isValidEmail('user@.')).toBe(false)
  })

  test('rejects strings without local part', () => {
    expect(isValidEmail('@example.com')).toBe(false)
  })

  test('rejects strings with spaces in middle', () => {
    expect(isValidEmail('user @example.com')).toBe(false)
    expect(isValidEmail('user@ example.com')).toBe(false)
  })
})

describe('isValidOtp', () => {
  test('accepts valid 6-digit codes', () => {
    expect(isValidOtp('123456')).toBe(true)
    expect(isValidOtp('000000')).toBe(true)
    expect(isValidOtp('999999')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidOtp('')).toBe(false)
  })

  test('rejects codes shorter than 6 digits', () => {
    expect(isValidOtp('12345')).toBe(false)
    expect(isValidOtp('1')).toBe(false)
  })

  test('rejects codes longer than 6 digits', () => {
    expect(isValidOtp('1234567')).toBe(false)
  })

  test('rejects non-numeric characters', () => {
    expect(isValidOtp('12345a')).toBe(false)
    expect(isValidOtp('abcdef')).toBe(false)
    expect(isValidOtp('12 456')).toBe(false)
  })
})
