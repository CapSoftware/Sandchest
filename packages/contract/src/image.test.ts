import { describe, test, expect } from 'bun:test'
import {
  parseImageRef,
  buildImageUri,
  isKnownToolchain,
  DEFAULT_TOOLCHAIN,
  IMAGE_URI_SCHEME,
  TOOLCHAINS,
} from './image.js'

describe('parseImageRef', () => {
  test('parses os-version only with default toolchain', () => {
    const ref = parseImageRef('ubuntu-22.04')
    expect(ref).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'base' })
  })

  test('parses os-version/toolchain format', () => {
    const ref = parseImageRef('ubuntu-22.04/node-22')
    expect(ref).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'node-22' })
  })

  test('parses sandchest:// URI scheme', () => {
    const ref = parseImageRef('sandchest://ubuntu-22.04/base')
    expect(ref).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'base' })
  })

  test('parses sandchest:// with custom toolchain', () => {
    const ref = parseImageRef('sandchest://ubuntu-24.04/python-3.12')
    expect(ref).toEqual({ osVersion: 'ubuntu-24.04', toolchain: 'python-3.12' })
  })

  test('strips trailing slash', () => {
    const ref = parseImageRef('ubuntu-22.04/')
    expect(ref).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'base' })
  })

  test('trims whitespace', () => {
    const ref = parseImageRef('  ubuntu-22.04/go-1.22  ')
    expect(ref).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'go-1.22' })
  })

  test('returns null for empty string', () => {
    expect(parseImageRef('')).toBeNull()
  })

  test('returns null for whitespace-only string', () => {
    expect(parseImageRef('   ')).toBeNull()
  })

  test('returns null for too many path segments', () => {
    expect(parseImageRef('a/b/c')).toBeNull()
  })

  test('returns null for scheme-only', () => {
    expect(parseImageRef('sandchest://')).toBeNull()
  })

  test('handles debian distro', () => {
    const ref = parseImageRef('debian-12/base')
    expect(ref).toEqual({ osVersion: 'debian-12', toolchain: 'base' })
  })
})

describe('buildImageUri', () => {
  test('builds correct URI', () => {
    expect(buildImageUri('ubuntu-22.04', 'base')).toBe('sandchest://ubuntu-22.04/base')
  })

  test('builds URI with custom toolchain', () => {
    expect(buildImageUri('ubuntu-24.04', 'node-22')).toBe('sandchest://ubuntu-24.04/node-22')
  })

  test('roundtrips with parseImageRef', () => {
    const uri = buildImageUri('ubuntu-22.04', 'python-3.12')
    const parsed = parseImageRef(uri)
    expect(parsed).toEqual({ osVersion: 'ubuntu-22.04', toolchain: 'python-3.12' })
  })
})

describe('isKnownToolchain', () => {
  test('returns true for known toolchains', () => {
    expect(isKnownToolchain('base')).toBe(true)
    expect(isKnownToolchain('node-22')).toBe(true)
    expect(isKnownToolchain('python-3.12')).toBe(true)
    expect(isKnownToolchain('go-1.22')).toBe(true)
  })

  test('returns false for unknown toolchains', () => {
    expect(isKnownToolchain('ruby-3.2')).toBe(false)
    expect(isKnownToolchain('')).toBe(false)
    expect(isKnownToolchain('nodejs')).toBe(false)
  })
})

describe('constants', () => {
  test('DEFAULT_TOOLCHAIN is base', () => {
    expect(DEFAULT_TOOLCHAIN).toBe('base')
  })

  test('IMAGE_URI_SCHEME is sandchest', () => {
    expect(IMAGE_URI_SCHEME).toBe('sandchest')
  })

  test('TOOLCHAINS contains expected entries', () => {
    expect(TOOLCHAINS).toContain('base')
    expect(TOOLCHAINS).toContain('node-22')
    expect(TOOLCHAINS).toContain('python-3.12')
    expect(TOOLCHAINS).toContain('go-1.22')
    expect(TOOLCHAINS.length).toBe(4)
  })
})
