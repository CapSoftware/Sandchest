import { describe, expect, test } from 'bun:test'
import { NotFoundError } from '../../sdk-ts/dist/index.js'
import { SandboxSmokeTracker, resolveSandboxSmokeOptions } from './sandbox-smoke.js'

describe('resolveSandboxSmokeOptions', () => {
  test('uses env api key and config base URL defaults', () => {
    const originalApiKey = process.env['SANDCHEST_API_KEY']
    process.env['SANDCHEST_API_KEY'] = 'sk_test_admin'

    try {
      const resolved = resolveSandboxSmokeOptions({}, { baseUrl: 'https://admin.example.com/' })
      expect(resolved.apiKey).toBe('sk_test_admin')
      expect(resolved.baseUrl).toBe('https://admin.example.com')
      expect(resolved.profile).toBe('small')
      expect(resolved.ttlSeconds).toBe(600)
    } finally {
      if (originalApiKey === undefined) {
        delete process.env['SANDCHEST_API_KEY']
      } else {
        process.env['SANDCHEST_API_KEY'] = originalApiKey
      }
    }
  })

  test('rejects invalid profile names', () => {
    expect(() =>
      resolveSandboxSmokeOptions({ apiKey: 'sk_test', profile: 'xlarge' as never }),
    ).toThrow("Invalid profile 'xlarge'")
  })
})

describe('SandboxSmokeTracker', () => {
  test('cleans up sessions before sandboxes in reverse order', async () => {
    const order: string[] = []
    const tracker = new SandboxSmokeTracker()

    tracker.trackSandbox('root', {
      id: 'sb_root',
      destroy: async () => {
        order.push('sandbox:root')
      },
    })
    tracker.trackSession('shell', {
      id: 'sess_1',
      destroy: async () => {
        order.push('session:shell')
      },
    })
    tracker.trackSandbox('fork', {
      id: 'sb_fork',
      destroy: async () => {
        order.push('sandbox:fork')
      },
    })

    const failures = await tracker.cleanup()

    expect(failures).toHaveLength(0)
    expect(order).toEqual(['session:shell', 'sandbox:fork', 'sandbox:root'])
  })

  test('skips released sessions and ignores not found cleanup errors', async () => {
    const order: string[] = []
    const tracker = new SandboxSmokeTracker()

    tracker.trackSession('released', {
      id: 'sess_release',
      destroy: async () => {
        order.push('session:released')
      },
    })
    tracker.releaseSession('sess_release')

    tracker.trackSandbox('deleted', {
      id: 'sb_deleted',
      destroy: async () => {
        throw new NotFoundError({ message: 'gone', requestId: 'req_1' })
      },
    })

    const failures = await tracker.cleanup()

    expect(failures).toHaveLength(0)
    expect(order).toEqual([])
  })

  test('continues cleanup after failures and reports them', async () => {
    const order: string[] = []
    const tracker = new SandboxSmokeTracker()

    tracker.trackSandbox('root', {
      id: 'sb_root',
      destroy: async () => {
        order.push('sandbox:root')
      },
    })
    tracker.trackSandbox('fork', {
      id: 'sb_fork',
      destroy: async () => {
        order.push('sandbox:fork')
        throw new Error('destroy failed')
      },
    })

    const failures = await tracker.cleanup()

    expect(order).toEqual(['sandbox:fork', 'sandbox:root'])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.id).toBe('sb_fork')
    expect(failures[0]?.error.message).toBe('destroy failed')
  })
})
