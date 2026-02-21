import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-session.ts')

describe('useSession hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports authClient', () => {
    expect(src).toMatch(/import.*authClient.*from/)
  })

  test('delegates to authClient.useSession', () => {
    expect(src).toMatch(/authClient\.useSession\(\)/)
  })

  test('exports useSession function', () => {
    expect(src).toMatch(/export function useSession/)
  })
})
