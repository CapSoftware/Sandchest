import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-create-org.ts')

describe('useCreateOrg hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useMutation from @tanstack/react-query', () => {
    expect(src).toMatch(/import.*useMutation.*from ['"]@tanstack\/react-query['"]/)
  })

  test('imports authClient', () => {
    expect(src).toMatch(/import.*authClient.*from/)
  })

  test('exports useCreateOrg function', () => {
    expect(src).toMatch(/export function useCreateOrg/)
  })

  test('calls authClient.organization.create', () => {
    expect(src).toMatch(/authClient\.organization\.create/)
  })

  test('sets the new org as active after creation', () => {
    expect(src).toMatch(/authClient\.organization\.setActive/)
  })

  test('accepts name and slug parameters', () => {
    expect(src).toMatch(/name:\s*string/)
    expect(src).toMatch(/slug:\s*string/)
  })

  test('returns a useMutation result', () => {
    expect(src).toMatch(/return useMutation/)
  })

  test('invalidates orgs query on success', () => {
    expect(src).toMatch(/invalidateQueries/)
    expect(src).toMatch(/['"]orgs['"]/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\)/)
    expect(src).toMatch(/throw new Error/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
