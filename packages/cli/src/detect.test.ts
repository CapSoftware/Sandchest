import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { detectProject } from './detect.js'

describe('detectProject', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandchest-detect-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('detects bun project from bun.lockb', () => {
    writeFileSync(join(dir, 'bun.lockb'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/bun')
    expect(result.installCmd).toBe('bun install --frozen-lockfile')
  })

  test('detects bun project from bunfig.toml', () => {
    writeFileSync(join(dir, 'bunfig.toml'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/bun')
  })

  test('detects npm project from package-lock.json', () => {
    writeFileSync(join(dir, 'package-lock.json'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/node-22')
    expect(result.installCmd).toBe('npm ci')
  })

  test('detects yarn project from yarn.lock', () => {
    writeFileSync(join(dir, 'yarn.lock'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/node-22')
    expect(result.installCmd).toBe('yarn install --frozen-lockfile')
  })

  test('detects pnpm project from pnpm-lock.yaml', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/node-22')
    expect(result.installCmd).toBe('pnpm install --frozen-lockfile')
  })

  test('detects python project from pyproject.toml', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/python-3.12')
    expect(result.installCmd).toBe('pip install -e .')
  })

  test('detects python project from requirements.txt', () => {
    writeFileSync(join(dir, 'requirements.txt'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/python-3.12')
    expect(result.installCmd).toBe('pip install -r requirements.txt')
  })

  test('detects go project from go.mod', () => {
    writeFileSync(join(dir, 'go.mod'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/go-1.22')
    expect(result.installCmd).toBe('go mod download')
  })

  test('falls back to base image for unknown projects', () => {
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/base')
    expect(result.installCmd).toBeNull()
  })

  test('bun takes priority over npm', () => {
    writeFileSync(join(dir, 'bun.lockb'), '')
    writeFileSync(join(dir, 'package-lock.json'), '')
    const result = detectProject(dir)
    expect(result.image).toBe('ubuntu-22.04/bun')
  })

  test('all detections use /work as workDir', () => {
    const result = detectProject(dir)
    expect(result.workDir).toBe('/work')
  })
})
