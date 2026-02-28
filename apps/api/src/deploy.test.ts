import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const API_DIR = resolve(ROOT, 'apps', 'api')

function readFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8')
}

// ---------------------------------------------------------------------------
// Deploy API workflow
// ---------------------------------------------------------------------------

describe('deploy-api.yml', () => {
  const workflow = readFile('.github/workflows/deploy-api.yml')

  test('triggers on push to main and manual dispatch', () => {
    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain('workflow_dispatch')
  })

  test('has path filters for API and dependencies', () => {
    expect(workflow).toContain('apps/api/**')
    expect(workflow).toContain('packages/contract/**')
    expect(workflow).toContain('packages/db/**')
    expect(workflow).toContain('fly.toml')
  })

  test('has check job before migrate', () => {
    expect(workflow).toContain('check:')
    expect(workflow).toContain('Typecheck & Test')
  })

  test('has migrate job that runs database migrations', () => {
    expect(workflow).toContain('migrate:')
    expect(workflow).toContain('Run database migrations')
    expect(workflow).toContain('bun run db:migrate:run')
    expect(workflow).toContain('DATABASE_URL')
  })

  test('has deploy job that depends on migrate', () => {
    expect(workflow).toContain('deploy:')
    expect(workflow).toContain('needs: migrate')
  })

  test('deploys to Fly.io', () => {
    expect(workflow).toContain('flyctl deploy --remote-only')
    expect(workflow).toContain('FLY_ACCESS_TOKEN')
  })

  test('uses concurrency group to prevent parallel deploys', () => {
    expect(workflow).toContain('concurrency:')
    expect(workflow).toContain('cancel-in-progress: false')
  })
})

// ---------------------------------------------------------------------------
// Deploy Node workflow
// ---------------------------------------------------------------------------

describe('deploy-node.yml', () => {
  const workflow = readFile('.github/workflows/deploy-node.yml')

  test('triggers on push to main with crate path filters', () => {
    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain('crates/**')
    expect(workflow).toContain('packages/contract/proto/**')
  })

  test('supports manual dispatch', () => {
    expect(workflow).toContain('workflow_dispatch')
  })

  test('installs protobuf compiler', () => {
    expect(workflow).toContain('protobuf-compiler')
  })

  test('builds release binary for sandchest-node', () => {
    expect(workflow).toContain('cargo build --release --package sandchest-node')
  })

  test('uploads binary artifact with retention', () => {
    expect(workflow).toContain('upload-artifact@v4')
    expect(workflow).toContain('retention-days: 30')
  })

  test('uploads binary to R2', () => {
    expect(workflow).toContain('aws s3 cp')
    expect(workflow).toContain('binaries/sandchest-node')
    expect(workflow).toContain('R2_ENDPOINT')
  })

  test('deploys to Hetzner via SSH', () => {
    expect(workflow).toContain('Deploy to Hetzner')
    expect(workflow).toContain('HETZNER_SSH_KEY')
    expect(workflow).toContain('HETZNER_HOST')
    expect(workflow).toContain('systemctl restart sandchest-node')
  })

  test('uses concurrency group to prevent parallel deploys', () => {
    expect(workflow).toContain('concurrency:')
    expect(workflow).toContain('cancel-in-progress: false')
  })
})

// ---------------------------------------------------------------------------
// CI workflow
// ---------------------------------------------------------------------------

describe('ci.yml', () => {
  const workflow = readFile('.github/workflows/ci.yml')

  test('runs on PR and push to main', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('branches: [main]')
  })

  test('has typecheck and lint job', () => {
    expect(workflow).toContain('typecheck-and-lint')
    expect(workflow).toContain('bun run typecheck')
    expect(workflow).toContain('bun run lint')
  })

  test('has TypeScript test job', () => {
    expect(workflow).toContain('test-ts')
    expect(workflow).toContain('bun run test')
  })

  test('has Rust check job with clippy', () => {
    expect(workflow).toContain('check-rust')
    expect(workflow).toContain('cargo check --workspace')
    expect(workflow).toContain('cargo test --workspace')
    expect(workflow).toContain('cargo clippy --workspace -- -D warnings')
  })

  test('cancels in-progress runs on same ref', () => {
    expect(workflow).toContain('cancel-in-progress: true')
  })
})

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Required deployment files
// ---------------------------------------------------------------------------

describe('required deployment files', () => {
  test('required files exist', () => {
    expect(existsSync(resolve(ROOT, 'apps/api/Dockerfile'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/deploy-api.yml'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/deploy-node.yml'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/ci.yml'))).toBe(true)
  })
})
