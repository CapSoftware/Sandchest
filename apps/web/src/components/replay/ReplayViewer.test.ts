import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const viewerSrc = readFileSync(
  join(import.meta.dir, 'ReplayViewer.tsx'),
  'utf-8',
)

const timelineSrc = readFileSync(
  join(import.meta.dir, 'Timeline.tsx'),
  'utf-8',
)

const forkTreeSrc = readFileSync(
  join(import.meta.dir, 'ForkTree.tsx'),
  'utf-8',
)

const ansiTextSrc = readFileSync(
  join(import.meta.dir, 'AnsiText.tsx'),
  'utf-8',
)

describe('ReplayViewer', () => {
  test('marks as client component', () => {
    expect(viewerSrc).toMatch(/^'use client'/)
  })

  test('uses TanStack Query hooks for data fetching', () => {
    expect(viewerSrc).toContain('useReplayBundle')
    expect(viewerSrc).toContain('useReplayEvents')
  })

  test('includes timeline tab as default', () => {
    expect(viewerSrc).toContain("useState<Tab>('timeline')")
  })

  test('includes all four tabs', () => {
    expect(viewerSrc).toContain("'timeline'")
    expect(viewerSrc).toContain("'execs'")
    expect(viewerSrc).toContain("'sessions'")
    expect(viewerSrc).toContain("'artifacts'")
  })

  test('renders live badge when in_progress', () => {
    expect(viewerSrc).toContain('replay-live-badge')
    expect(viewerSrc).toContain('replay-live-dot')
  })

  test('renders copy URL button', () => {
    expect(viewerSrc).toContain('CopyButton')
    expect(viewerSrc).toContain('Copy URL')
  })

  test('passes isLive to Timeline', () => {
    expect(viewerSrc).toContain('isLive={isLive}')
  })

  test('renders ForkTree component', () => {
    expect(viewerSrc).toContain('<ForkTree')
    expect(viewerSrc).toContain('tree={bundle.fork_tree}')
  })

  test('uses AnsiText for exec output', () => {
    expect(viewerSrc).toContain('<AnsiText')
    expect(viewerSrc).toContain('text={combinedOutput}')
  })

  test('no console.log in production code', () => {
    expect(viewerSrc).not.toContain('console.log')
  })
})

describe('Timeline', () => {
  test('marks as client component', () => {
    expect(timelineSrc).toMatch(/^'use client'/)
  })

  test('includes search functionality', () => {
    expect(timelineSrc).toContain('tl-search')
    expect(timelineSrc).toContain('Search events')
  })

  test('includes expand/collapse toggle', () => {
    expect(timelineSrc).toContain('Collapse all')
    expect(timelineSrc).toContain('Expand all')
  })

  test('groups exec output events', () => {
    expect(timelineSrc).toContain('groupEvents')
    expect(timelineSrc).toContain("'exec.output'")
  })

  test('auto-scrolls in live mode', () => {
    expect(timelineSrc).toContain('scrollIntoView')
    expect(timelineSrc).toContain('isLive')
  })

  test('renders elapsed timestamps', () => {
    expect(timelineSrc).toContain('formatElapsed')
    expect(timelineSrc).toContain('tl-time')
  })

  test('handles all event types', () => {
    const eventTypes = [
      'sandbox.created', 'sandbox.ready', 'sandbox.forked',
      'sandbox.stopping', 'sandbox.stopped', 'sandbox.failed',
      'sandbox.ttl_warning', 'exec.started', 'exec.completed',
      'exec.failed', 'session.created', 'session.destroyed',
      'file.written', 'file.deleted', 'artifact.registered',
      'artifact.collected',
    ]
    for (const type of eventTypes) {
      expect(timelineSrc).toContain(`'${type}'`)
    }
  })

  test('no console.log in production code', () => {
    expect(timelineSrc).not.toContain('console.log')
  })
})

describe('ForkTree', () => {
  test('marks as client component', () => {
    expect(forkTreeSrc).toMatch(/^'use client'/)
  })

  test('supports collapsing nodes', () => {
    expect(forkTreeSrc).toContain('collapsed')
    expect(forkTreeSrc).toContain('ft-collapse-btn')
  })

  test('highlights current sandbox', () => {
    expect(forkTreeSrc).toContain('ft-current')
    expect(forkTreeSrc).toContain('ft-id-current')
  })

  test('renders tree branch characters', () => {
    expect(forkTreeSrc).toContain('\\u2514\\u2500')
    expect(forkTreeSrc).toContain('\\u251c\\u2500')
  })

  test('links to other sandboxes', () => {
    expect(forkTreeSrc).toContain('ft-id-link')
    expect(forkTreeSrc).toContain('href={`/s/${node.sandbox_id}`}')
  })

  test('returns null for single-node tree', () => {
    expect(forkTreeSrc).toContain('tree.children.length === 0')
    expect(forkTreeSrc).toContain('return null')
  })

  test('no console.log in production code', () => {
    expect(forkTreeSrc).not.toContain('console.log')
  })
})

describe('AnsiText', () => {
  test('uses parseAnsi and useMemo', () => {
    expect(ansiTextSrc).toContain('parseAnsi')
    expect(ansiTextSrc).toContain('useMemo')
  })

  test('applies inline styles for ANSI attributes', () => {
    expect(ansiTextSrc).toContain('style.color')
    expect(ansiTextSrc).toContain('style.backgroundColor')
    expect(ansiTextSrc).toContain('style.fontWeight')
    expect(ansiTextSrc).toContain('style.opacity')
    expect(ansiTextSrc).toContain('style.textDecoration')
  })

  test('renders plain text without wrapping spans', () => {
    expect(ansiTextSrc).toContain('return seg.text')
  })

  test('no console.log in production code', () => {
    expect(ansiTextSrc).not.toContain('console.log')
  })
})
