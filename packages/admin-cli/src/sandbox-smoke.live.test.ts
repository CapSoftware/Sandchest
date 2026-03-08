import { describe, expect, test } from 'bun:test'
import { readConfig } from './config.js'
import { runSandboxSmokeTest } from './sandbox-smoke.js'

const RUN_ADMIN_SANDBOX_SMOKE_TESTS =
  process.env['RUN_ADMIN_SANDBOX_SMOKE_TESTS'] === '1'

describe.skipIf(!RUN_ADMIN_SANDBOX_SMOKE_TESTS)('sandbox smoke (live)', () => {
  test('runs the full production sandbox lifecycle through the SDK', async () => {
    const config = readConfig()
    const result = await runSandboxSmokeTest({
      apiKey: process.env['SANDCHEST_API_KEY'] ?? '',
      baseUrl: process.env['SANDCHEST_BASE_URL'] ?? config.api?.baseUrl,
    })

    expect(result.checks.length).toBeGreaterThanOrEqual(9)
    expect(result.rootSandboxId.startsWith('sb_')).toBe(true)
    expect(result.forkSandboxId.startsWith('sb_')).toBe(true)
  })
})
