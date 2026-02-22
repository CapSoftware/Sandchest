import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '../../../..')

describe('phase 9 gap audit', () => {
  test('collect_artifacts is implemented in node daemon', () => {
    const src = readFileSync(resolve(ROOT, 'crates/sandchest-node/src/main.rs'), 'utf-8')
    expect(src).toContain('collect_artifacts')
    expect(src).toContain('artifacts::collect')
    expect(src).not.toContain('Status::unimplemented')
  })

  test('org-hard-delete worker has cascade deletion', () => {
    const src = readFileSync(resolve(ROOT, 'apps/api/src/workers/org-hard-delete.ts'), 'utf-8')
    expect(src).toContain('findSoftDeletedBefore')
    expect(src).toContain('deleteByOrgId')
    expect(src).not.toContain('Effect.succeed(0)')
  })

  test('lastActivityAt column exists in DB schema', () => {
    const src = readFileSync(resolve(ROOT, 'packages/db/src/schema/sandboxes.ts'), 'utf-8')
    expect(src).toContain('lastActivityAt')
    expect(src).toContain('last_activity_at')
  })

  test('activity routes call touchLastActivity', () => {
    const activityRoutes = ['execs.ts', 'sessions.ts', 'files.ts']
    for (const route of activityRoutes) {
      const src = readFileSync(resolve(ROOT, 'apps/api/src/routes', route), 'utf-8')
      expect(src).toContain('touchLastActivity')
    }
  })

  test('deploy.yml contains TODO placeholders', () => {
    const src = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8')
    expect(src).toContain('TODO')
  })

  test('no Python SDK exists', () => {
    expect(existsSync(resolve(ROOT, 'packages/sdk-py'))).toBe(false)
  })

  test('no GitHub Action exists', () => {
    expect(existsSync(resolve(ROOT, 'action.yml'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'action.yaml'))).toBe(false)
  })

  test('auth middleware extracts scopes from API key metadata', () => {
    const src = readFileSync(resolve(ROOT, 'apps/api/src/middleware.ts'), 'utf-8')
    expect(src).toContain('scopes')
    expect(src).toContain('parseScopes')
  })

  test('all route files use requireScope', () => {
    const routeFiles = ['sandboxes.ts', 'execs.ts', 'sessions.ts', 'files.ts', 'artifacts.ts']
    for (const route of routeFiles) {
      const src = readFileSync(resolve(ROOT, 'apps/api/src/routes', route), 'utf-8')
      expect(src).toContain('requireScope')
    }
  })

  test('no audit log table in DB schema', () => {
    const schemas = ['sandboxes.ts', 'execs.ts', 'sandbox-sessions.ts', 'artifacts.ts', 'nodes.ts', 'images.ts', 'profiles.ts', 'org-quotas.ts', 'org-usage.ts', 'idempotency-keys.ts']
    for (const schema of schemas) {
      const path = resolve(ROOT, 'packages/db/src/schema', schema)
      if (existsSync(path)) {
        const src = readFileSync(path, 'utf-8')
        expect(src).not.toContain('audit_log')
      }
    }
    expect(existsSync(resolve(ROOT, 'packages/db/src/schema/audit-logs.ts'))).toBe(false)
  })

  test('MCP has exactly 9 tools (5 missing)', () => {
    const src = readFileSync(resolve(ROOT, 'packages/mcp/src/tools.ts'), 'utf-8')
    const toolCount = (src.match(/registerTool\(/g) ?? []).length
    expect(toolCount).toBe(9)
  })

  test('no create sandbox dialog in dashboard', () => {
    const src = readFileSync(resolve(ROOT, 'apps/web/src/components/dashboard/SandboxList.tsx'), 'utf-8')
    expect(src).not.toContain('CreateSandbox')
    expect(src).not.toContain('create sandbox')
  })

  test('no OpenTelemetry packages installed', () => {
    const apiPkg = readFileSync(resolve(ROOT, 'apps/api/package.json'), 'utf-8')
    expect(apiPkg).not.toContain('opentelemetry')
  })
})
