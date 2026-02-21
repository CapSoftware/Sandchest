import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(import.meta.dir, 'use-replay.ts'), 'utf-8')

describe('use-replay hook', () => {
  test('marks as client component', () => {
    expect(src).toMatch(/^'use client'/)
  })

  test('exports useReplayBundle hook', () => {
    expect(src).toContain('export function useReplayBundle')
  })

  test('exports useReplayEvents hook', () => {
    expect(src).toContain('export function useReplayEvents')
  })

  test('uses correct query key for replay bundle', () => {
    expect(src).toContain("queryKey: ['replay', sandboxId]")
  })

  test('uses correct query key for events', () => {
    expect(src).toContain("queryKey: ['replay-events', eventsUrl]")
  })

  test('fetches public replay endpoint', () => {
    expect(src).toContain('/v1/public/replay/')
  })

  test('polls when status is in_progress', () => {
    expect(src).toContain("'in_progress'")
    expect(src).toContain('refetchInterval')
  })

  test('stops polling when events are not live', () => {
    expect(src).toContain('isLive ? EVENT_POLL_MS : false')
  })

  test('parses JSONL events from events_url', () => {
    expect(src).toContain("split('\\n')")
    expect(src).toContain('JSON.parse')
  })

  test('no console.log in production code', () => {
    expect(src).not.toContain('console.log')
  })
})
