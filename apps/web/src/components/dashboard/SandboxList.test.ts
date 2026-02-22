import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'SandboxList.tsx')

describe('SandboxList component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useSandboxes hook for data fetching', () => {
    expect(src).toContain('useSandboxes')
    expect(src).toContain("from '@/hooks/use-sandboxes'")
    expect(src).toMatch(/useSandboxes\(statusFilter\)/)
  })

  test('uses useStopSandbox hook for stop mutation', () => {
    expect(src).toContain('useStopSandbox')
    expect(src).toMatch(/useStopSandbox\(\)/)
  })

  test('renders Create sandbox button in page header', () => {
    expect(src).toMatch(/Create sandbox/)
    expect(src).toMatch(/dash-primary-btn/)
  })

  test('renders CreateSandboxDialog component', () => {
    expect(src).toContain('CreateSandboxDialog')
    expect(src).toMatch(/import.*CreateSandboxDialog/)
  })

  test('manages showCreate state for dialog visibility', () => {
    expect(src).toMatch(/showCreate/)
    expect(src).toMatch(/setShowCreate/)
  })

  test('does not use useEffect for data fetching', () => {
    expect(src).not.toMatch(/useEffect/)
  })

  test('does not use useCallback', () => {
    expect(src).not.toMatch(/useCallback/)
  })

  test('does not import apiFetch directly', () => {
    expect(src).not.toMatch(/import.*apiFetch/)
  })

  test('uses infinite query pagination with fetchNextPage', () => {
    expect(src).toMatch(/fetchNextPage/)
    expect(src).toMatch(/hasNextPage/)
  })

  test('flattens pages to get sandboxes list', () => {
    expect(src).toMatch(/pages\.flatMap/)
  })

  test('calls stopSandbox.mutate on stop button click', () => {
    expect(src).toMatch(/stopSandbox\.mutate\(/)
  })

  test('uses isPending for loading state instead of manual state', () => {
    expect(src).toMatch(/stopSandbox\.isPending/)
    expect(src).toMatch(/isLoading/)
  })

  test('renders status filter buttons', () => {
    expect(src).toMatch(/FILTER_OPTIONS/)
    expect(src).toMatch(/dash-filter-btn/)
  })

  test('renders sandbox table with expected columns', () => {
    expect(src).toMatch(/dash-table/)
    expect(src).toMatch(/>ID</)
    expect(src).toMatch(/>Status</)
    expect(src).toMatch(/>Image</)
    expect(src).toMatch(/>Profile</)
    expect(src).toMatch(/>Created</)
  })

  test('renders StatusBadge for sandbox status', () => {
    expect(src).toMatch(/StatusBadge/)
  })

  test('shows error from both query and mutation', () => {
    expect(src).toMatch(/\{error &&/)
    expect(src).toMatch(/stopSandbox\.error/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
