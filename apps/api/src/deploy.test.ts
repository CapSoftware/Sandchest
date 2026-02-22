import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const API_DIR = resolve(ROOT, 'apps', 'api')

function readFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8')
}

describe('deploy.yml', () => {
  const workflow = readFile('.github/workflows/deploy.yml')

  test('triggers on push to main and manual dispatch', () => {
    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain('workflow_dispatch')
  })

  test('has migrate job that runs before deploys', () => {
    expect(workflow).toContain('migrate:')
    expect(workflow).toContain('Run database migrations')
    expect(workflow).toContain('bun run db:migrate:run')
    expect(workflow).toContain('DATABASE_URL')
  })

  test('has deploy-api job using Fly.io', () => {
    expect(workflow).toContain('deploy-api:')
    expect(workflow).toContain('needs: [migrate]')
    expect(workflow).toContain('superfly/flyctl-actions/setup-flyctl')
    expect(workflow).toContain('flyctl deploy')
    expect(workflow).toContain('FLY_API_TOKEN')
  })

  test('deploy-api references correct Dockerfile and fly.toml paths', () => {
    expect(workflow).toContain('--config apps/api/fly.toml')
    expect(workflow).toContain('--dockerfile apps/api/Dockerfile')
  })

  test('has deploy-web job using Vercel', () => {
    expect(workflow).toContain('deploy-web:')
    expect(workflow).toContain('vercel deploy --prod')
    expect(workflow).toContain('VERCEL_TOKEN')
    expect(workflow).toContain('VERCEL_ORG_ID')
    expect(workflow).toContain('VERCEL_PROJECT_ID')
  })

  test('both deploy jobs depend on migrate', () => {
    const apiNeeds = workflow.match(/deploy-api:[\s\S]*?needs:\s*\[migrate\]/)
    const webNeeds = workflow.match(/deploy-web:[\s\S]*?needs:\s*\[migrate\]/)
    expect(apiNeeds).not.toBeNull()
    expect(webNeeds).not.toBeNull()
  })

  test('all jobs use production environment', () => {
    const envMatches = workflow.match(/environment:\s*production/g)
    expect(envMatches).not.toBeNull()
    expect(envMatches!.length).toBeGreaterThanOrEqual(3)
  })

  test('has no TODO placeholders', () => {
    expect(workflow).not.toContain('TODO')
    expect(workflow).not.toMatch(/echo\s+["']TODO/)
  })
})

describe('Dockerfile', () => {
  const dockerfile = readFileSync(resolve(API_DIR, 'Dockerfile'), 'utf-8')

  test('uses multi-stage build', () => {
    const fromStatements = dockerfile.match(/^FROM\s/gm)
    expect(fromStatements).not.toBeNull()
    expect(fromStatements!.length).toBeGreaterThanOrEqual(3)
  })

  test('uses official Bun image', () => {
    expect(dockerfile).toContain('FROM oven/bun:1')
  })

  test('installs dependencies with frozen lockfile', () => {
    expect(dockerfile).toContain('bun install --frozen-lockfile')
  })

  test('builds contract and api packages', () => {
    expect(dockerfile).toContain('--filter @sandchest/contract build')
    expect(dockerfile).toContain('--filter @sandchest/api build')
  })

  test('production stage uses slim image', () => {
    expect(dockerfile).toContain('FROM oven/bun:1-slim')
  })

  test('sets NODE_ENV to production', () => {
    expect(dockerfile).toContain('ENV NODE_ENV=production')
  })

  test('exposes correct port', () => {
    expect(dockerfile).toContain('EXPOSE 3001')
  })

  test('runs compiled output', () => {
    expect(dockerfile).toContain('apps/api/dist/index.js')
  })

  test('copies workspace package.json files for dependency install', () => {
    expect(dockerfile).toContain('COPY packages/contract/package.json')
    expect(dockerfile).toContain('COPY packages/db/package.json')
  })
})

describe('fly.toml', () => {
  const flytoml = readFileSync(resolve(API_DIR, 'fly.toml'), 'utf-8')

  test('sets app name', () => {
    expect(flytoml).toContain('app = "sandchest-api"')
  })

  test('configures HTTP service on port 3001', () => {
    expect(flytoml).toContain('internal_port = 3001')
    expect(flytoml).toContain('force_https = true')
  })

  test('has health check on /healthz', () => {
    expect(flytoml).toContain('path = "/healthz"')
  })

  test('configures auto-start and minimum machines', () => {
    expect(flytoml).toContain('auto_start_machines = true')
    expect(flytoml).toContain('min_machines_running = 1')
  })

  test('references correct Dockerfile', () => {
    expect(flytoml).toContain('dockerfile = "Dockerfile"')
  })
})
