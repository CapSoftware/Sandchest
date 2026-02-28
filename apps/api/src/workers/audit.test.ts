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

  test('deploy.yml has real deployment targets', () => {
    const src = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8')
    expect(src).not.toContain('TODO')
    expect(src).toContain('flyctl deploy')
  })

  test('Python SDK exists', () => {
    expect(existsSync(resolve(ROOT, 'packages/sdk-py'))).toBe(true)
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

  test('audit log table exists in DB schema', () => {
    expect(existsSync(resolve(ROOT, 'packages/db/src/schema/audit-logs.ts'))).toBe(true)
    const src = readFileSync(resolve(ROOT, 'packages/db/src/schema/audit-logs.ts'), 'utf-8')
    expect(src).toContain('audit_logs')
    expect(src).toContain('org_id')
    expect(src).toContain('action')
  })

  test('MCP has all 14 tools', () => {
    const src = readFileSync(resolve(ROOT, 'packages/mcp/src/tools.ts'), 'utf-8')
    const toolCount = (src.match(/registerTool\(/g) ?? []).length
    expect(toolCount).toBe(14)
  })

  test('dashboard has create sandbox dialog', () => {
    const src = readFileSync(resolve(ROOT, 'apps/web/src/components/dashboard/SandboxList.tsx'), 'utf-8')
    expect(src).toContain('CreateSandbox')
  })

  test('no OpenTelemetry packages installed', () => {
    const apiPkg = readFileSync(resolve(ROOT, 'apps/api/package.json'), 'utf-8')
    expect(apiPkg).not.toContain('opentelemetry')
  })
})
