import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-update-user.ts')

describe('useUpdateUser hook', () => {
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

  test('exports useUpdateUser function', () => {
    expect(src).toMatch(/export function useUpdateUser/)
  })

  test('calls authClient.updateUser', () => {
    expect(src).toMatch(/authClient\.updateUser/)
  })

  test('accepts name parameter', () => {
    expect(src).toMatch(/name:\s*string/)
  })

  test('returns a useMutation result', () => {
    expect(src).toMatch(/return useMutation/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\) throw new Error/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
