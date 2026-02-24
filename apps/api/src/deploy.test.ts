import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const API_DIR = resolve(ROOT, 'apps', 'api')

function readFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8')
}

// ---------------------------------------------------------------------------
// Deploy workflow (SST)
// ---------------------------------------------------------------------------

describe('deploy.yml', () => {
  const workflow = readFile('.github/workflows/deploy.yml')

  test('triggers on push to main and manual dispatch', () => {
    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain('workflow_dispatch')
  })

  test('has migrate job that runs before deploy', () => {
    expect(workflow).toContain('migrate:')
    expect(workflow).toContain('Run database migrations')
    expect(workflow).toContain('bun run db:migrate:run')
    expect(workflow).toContain('DATABASE_URL')
  })

  test('has deploy job using SST', () => {
    expect(workflow).toContain('deploy:')
    expect(workflow).toContain('needs: [migrate]')
    expect(workflow).toContain('bunx sst deploy')
  })

  test('deploy job assumes AWS role via OIDC', () => {
    expect(workflow).toContain('aws-actions/configure-aws-credentials@v4')
    expect(workflow).toContain('role-to-assume')
    expect(workflow).toContain('AWS_ROLE_ARN')
  })

  test('requests id-token permission for OIDC', () => {
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('contents: read')
  })

  test('supports stage selection via workflow_dispatch', () => {
    expect(workflow).toContain('stage:')
    expect(workflow).toContain('SST stage to deploy')
    expect(workflow).toMatch(/options:\s*\n\s*- dev\s*\n\s*- production/)
  })

  test('uses concurrency group to prevent parallel deploys', () => {
    expect(workflow).toContain('concurrency:')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  test('has no TODO placeholders', () => {
    expect(workflow).not.toContain('TODO')
    expect(workflow).not.toMatch(/echo\s+["']TODO/)
  })
})

// ---------------------------------------------------------------------------
// Docker build workflow
// ---------------------------------------------------------------------------

describe('docker-build.yml', () => {
  const workflow = readFile('.github/workflows/docker-build.yml')

  test('triggers on API and dependency path changes', () => {
    expect(workflow).toContain('apps/api/**')
    expect(workflow).toContain('packages/contract/**')
    expect(workflow).toContain('packages/db/**')
  })

  test('uses ECR for container registry', () => {
    expect(workflow).toContain('amazon-ecr-login@v2')
    expect(workflow).toContain('sandchest-api')
  })

  test('references correct Dockerfile path', () => {
    expect(workflow).toContain('file: apps/api/Dockerfile')
  })

  test('tags images with SHA and latest', () => {
    expect(workflow).toContain('github.sha')
    expect(workflow).toContain('sandchest-api:latest')
  })

  test('uses GitHub Actions cache for buildx', () => {
    expect(workflow).toContain('cache-from: type=gha')
    expect(workflow).toContain('cache-to: type=gha,mode=max')
  })
})

// ---------------------------------------------------------------------------
// Rust build workflow
// ---------------------------------------------------------------------------

describe('rust-build.yml', () => {
  const workflow = readFile('.github/workflows/rust-build.yml')

  test('triggers on node daemon and proto changes', () => {
    expect(workflow).toContain('crates/sandchest-node/**')
    expect(workflow).toContain('packages/contract/proto/**')
  })

  test('builds release binary for sandchest-node', () => {
    expect(workflow).toContain('cargo build --release --package sandchest-node')
  })

  test('installs protobuf compiler', () => {
    expect(workflow).toContain('protobuf-compiler')
  })

  test('uploads binary artifact and pushes to S3', () => {
    expect(workflow).toContain('upload-artifact@v4')
    expect(workflow).toContain('retention-days: 30')
    expect(workflow).toContain('aws s3 cp')
    expect(workflow).toContain('binaries/sandchest-node')
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
// SST config
// ---------------------------------------------------------------------------

describe('sst.config.ts', () => {
  const config = readFile('sst.config.ts')

  test('exists and imports all infra modules', () => {
    expect(config).toContain('infra/alarms')
    expect(config).toContain('infra/app')
    expect(config).toContain('infra/bucket')
    expect(config).toContain('infra/cluster')
    expect(config).toContain('infra/node')
    expect(config).toContain('infra/oidc')
    expect(config).toContain('infra/redis')
    expect(config).toContain('infra/vpc')
  })

  test('creates all core infrastructure resources', () => {
    expect(config).toContain('sst.aws.Vpc')
    expect(config).toContain('sst.aws.Redis')
    expect(config).toContain('sst.aws.Bucket')
    expect(config).toContain('sst.aws.Cluster')
    expect(config).toContain('sst.Secret')
  })

  test('links secrets and resources to API service', () => {
    expect(config).toContain('link: [')
    expect(config).toContain('redis')
    expect(config).toContain('artifactBucket')
    expect(config).toContain('databaseUrl')
    expect(config).toContain('betterAuthSecret')
    expect(config).toContain('resendApiKey')
  })

  test('creates node LaunchTemplate and ASG', () => {
    expect(config).toContain('aws.ec2.LaunchTemplate')
    expect(config).toContain('NodeLaunchTemplate')
    expect(config).toContain('aws.autoscaling.Group')
    expect(config).toContain('NodeAsg')
  })

  test('creates GitHub OIDC provider and deploy role', () => {
    expect(config).toContain('aws.iam.OpenIdConnectProvider')
    expect(config).toContain('GitHubOidc')
    expect(config).toContain('DeployRole')
  })

  test('creates CloudWatch alarms', () => {
    expect(config).toContain('EcsRunningTaskAlarm')
    expect(config).toContain('EcsCpuAlarm')
    expect(config).toContain('EcsMemoryAlarm')
    expect(config).toContain('Alb5xxAlarm')
    expect(config).toContain('AlbResponseTimeAlarm')
    expect(config).toContain('RedisMemoryAlarm')
    expect(config).toContain('RedisEvictionAlarm')
    expect(config).toContain('NodeHeartbeatAlarm')
    expect(config).toContain('NodeAsgAlarm')
  })

  test('exports infrastructure outputs', () => {
    expect(config).toContain('vpcId')
    expect(config).toContain('redisHost')
    expect(config).toContain('artifactBucketName')
    expect(config).toContain('apiUrl')
    expect(config).toContain('nodeAsgName')
    expect(config).toContain('deployRoleArn')
    expect(config).toContain('alarmTopicArn')
  })

  test('grants node IAM roles for S3 and CloudWatch', () => {
    expect(config).toContain('NodeS3Policy')
    expect(config).toContain('NodeCloudWatchPolicy')
    expect(config).toContain('s3:PutObject')
    expect(config).toContain('s3:GetObject')
    expect(config).toContain('cloudwatch:PutMetricData')
  })

  test('references Dockerfile in correct location', () => {
    expect(config).toContain('dockerfile: "apps/api/Dockerfile"')
  })

  test('required files exist', () => {
    expect(existsSync(resolve(ROOT, 'sst.config.ts'))).toBe(true)
    expect(existsSync(resolve(ROOT, 'apps/api/Dockerfile'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/deploy.yml'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/docker-build.yml'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/rust-build.yml'))).toBe(true)
    expect(existsSync(resolve(ROOT, '.github/workflows/ci.yml'))).toBe(true)
  })
})
