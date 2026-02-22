import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Effect, Layer, Scope, Exit } from 'effect'
import { HttpMiddleware, HttpServer, HttpServerRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { ApiRouter } from './server.js'
import { AuthContext } from './context.js'
import { withRequestId } from './middleware.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { SandboxRepo } from './services/sandbox-repo.js'
import { ExecRepo } from './services/exec-repo.js'
import { SessionRepo } from './services/session-repo.js'
import { ObjectStorage } from './services/object-storage.js'
import { NodeClient } from './services/node-client.js'
import { ArtifactRepo } from './services/artifact-repo.js'
import { RedisService } from './services/redis.js'
import { QuotaService } from './services/quota.js'
import { BillingService } from './services/billing.js'
import { AuditLog } from './services/audit-log.js'
import { createInMemorySandboxRepo } from './services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from './services/exec-repo.memory.js'
import { createInMemorySessionRepo } from './services/session-repo.memory.js'
import { createInMemoryObjectStorage } from './services/object-storage.memory.js'
import { createInMemoryNodeClient } from './services/node-client.memory.js'
import { createInMemoryRedisApi } from './services/redis.memory.js'
import { createInMemoryArtifactRepo } from './services/artifact-repo.memory.js'
import { createInMemoryQuotaApi } from './services/quota.memory.js'
import { createInMemoryBillingApi } from './services/billing.memory.js'
import { createInMemoryAuditLog } from './services/audit-log.memory.js'
import { JsonLoggerLive } from './logger.js'
import { ShutdownControllerLive } from './shutdown.js'
import { sstResource } from './env.js'
import type { RedisApi, BufferedEvent } from './services/redis.js'
import type { ObjectStorageApi } from './services/object-storage.js'
import type { NodeClientApi } from './services/node-client.js'
import type { QuotaApi } from './services/quota.js'

// Infra config imports
import { getAppConfig } from '../../../infra/app.js'
import { getVpcConfig, getVpcNat, isProduction } from '../../../infra/vpc.js'
import {
  getRedisConfig,
  getRedisInstance,
  getRedisNodes,
} from '../../../infra/redis.js'
import {
  getBucketConfig,
  getArtifactLifecycle,
} from '../../../infra/bucket.js'
import {
  getServiceCpu,
  getServiceMemory,
  getServiceScaling,
  getServiceHealthCheck,
  getServicePort,
  getServiceEnvironment,
} from '../../../infra/cluster.js'
import {
  getNodeInstanceType,
  getNodeRootVolumeGb,
  getNodeGrpcPort,
  getNodeAmiSsmParameter,
  getNodeEnvironment,
  getNodeSystemdUnit,
  getNodeUserData,
} from '../../../infra/node.js'
import {
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_THUMBPRINTS,
  GITHUB_REPO,
  getDeployRoleName,
  getDeployRoleTrustPolicy,
} from '../../../infra/oidc.js'
import {
  getSnsTopicName,
  getEcsRunningTaskAlarm,
  getEcsCpuAlarm,
  getEcsMemoryAlarm,
  getAlb5xxAlarm,
  getAlbResponseTimeAlarm,
  getAlbUnhealthyHostAlarm,
  getRedisMemoryAlarm,
  getRedisEvictionAlarm,
  getNodeHeartbeatAlarm,
  NODE_HEARTBEAT_NAMESPACE,
  NODE_HEARTBEAT_METRIC,
} from '../../../infra/alarms.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = 'test_org_smoke'
const TEST_USER = 'test_user_smoke'

// ---------------------------------------------------------------------------
// 1. Infra Config — VPC
// ---------------------------------------------------------------------------

describe('infra: VPC config', () => {
  test('all stages use EC2 NAT', () => {
    expect(getVpcNat('production')).toBe('ec2')
    expect(getVpcNat('dev')).toBe('ec2')
    expect(getVpcNat('staging')).toBe('ec2')
  })

  test('VPC config has 2 AZs', () => {
    const config = getVpcConfig('production')
    expect(config.az).toBe(2)
  })

  test('isProduction identifies production stage only', () => {
    expect(isProduction('production')).toBe(true)
    expect(isProduction('dev')).toBe(false)
    expect(isProduction('staging')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Infra Config — Redis
// ---------------------------------------------------------------------------

describe('infra: Redis config', () => {
  test('production uses t4g.small instances', () => {
    expect(getRedisInstance('production')).toBe('t4g.small')
  })

  test('dev uses t4g.micro instances', () => {
    expect(getRedisInstance('dev')).toBe('t4g.micro')
  })

  test('single node for all stages', () => {
    expect(getRedisNodes('production')).toBe(1)
    expect(getRedisNodes('dev')).toBe(1)
  })

  test('Redis config uses Valkey 7.2', () => {
    const config = getRedisConfig('dev', {})
    expect(config.engine).toBe('valkey')
    expect(config.version).toBe('7.2')
    expect(config.cluster.nodes).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Infra Config — S3 Bucket
// ---------------------------------------------------------------------------

describe('infra: S3 bucket config', () => {
  test('has three lifecycle rules', () => {
    const rules = getArtifactLifecycle('production')
    expect(rules).toHaveLength(3)
    expect(rules.map((r) => r.id)).toEqual([
      'expire-tmp-uploads',
      'expire-event-logs',
      'expire-artifacts',
    ])
  })

  test('tmp uploads expire in 1 day for all stages', () => {
    const prodRules = getArtifactLifecycle('production')
    const devRules = getArtifactLifecycle('dev')
    expect(prodRules[0].expiresIn).toBe('1 day')
    expect(devRules[0].expiresIn).toBe('1 day')
  })

  test('production event logs expire in 365 days, dev in 30', () => {
    const prodRules = getArtifactLifecycle('production')
    const devRules = getArtifactLifecycle('dev')
    expect(prodRules[1].expiresIn).toBe('365 days')
    expect(devRules[1].expiresIn).toBe('30 days')
  })

  test('production artifacts expire in 365 days, dev in 30', () => {
    const prodRules = getArtifactLifecycle('production')
    const devRules = getArtifactLifecycle('dev')
    expect(prodRules[2].expiresIn).toBe('365 days')
    expect(devRules[2].expiresIn).toBe('30 days')
  })

  test('versioning enabled only in production', () => {
    expect(getBucketConfig('production').versioning).toBe(true)
    expect(getBucketConfig('dev').versioning).toBe(false)
  })

  test('HTTPS always enforced', () => {
    expect(getBucketConfig('production').enforceHttps).toBe(true)
    expect(getBucketConfig('dev').enforceHttps).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Infra Config — ECS Cluster
// ---------------------------------------------------------------------------

describe('infra: ECS cluster config', () => {
  test('production has more CPU and memory', () => {
    expect(getServiceCpu('production')).toBe('1 vCPU')
    expect(getServiceCpu('dev')).toBe('0.25 vCPU')
    expect(getServiceMemory('production')).toBe('2 GB')
    expect(getServiceMemory('dev')).toBe('0.5 GB')
  })

  test('production scales 2-10, dev scales 1-2', () => {
    const prod = getServiceScaling('production')
    const dev = getServiceScaling('dev')
    expect(prod).toEqual({ min: 2, max: 10, cpuUtilization: 70, memoryUtilization: 70 })
    expect(dev).toEqual({ min: 1, max: 2, cpuUtilization: 80, memoryUtilization: 80 })
  })

  test('health check targets /healthz', () => {
    const health = getServiceHealthCheck()
    expect(health.path).toBe('/healthz')
    expect(health.interval).toBe('15 seconds')
    expect(health.timeout).toBe('5 seconds')
  })

  test('service port forwards 80 to 3001', () => {
    const port = getServicePort()
    expect(port.listen).toBe('80/http')
    expect(port.forward).toBe('3001/http')
  })

  test('service environment sets PORT and NODE_ENV', () => {
    const prodEnv = getServiceEnvironment('production')
    const devEnv = getServiceEnvironment('dev')
    expect(prodEnv.PORT).toBe('3001')
    expect(prodEnv.NODE_ENV).toBe('production')
    expect(devEnv.NODE_ENV).toBe('development')
    expect(prodEnv.DRAIN_TIMEOUT_MS).toBe('30000')
  })

  test('production base URL uses api.sandchest.com', () => {
    const prodEnv = getServiceEnvironment('production')
    expect(prodEnv.BETTER_AUTH_BASE_URL).toBe('https://api.sandchest.com')
  })

  test('dev base URL uses stage prefix', () => {
    const devEnv = getServiceEnvironment('dev')
    expect(devEnv.BETTER_AUTH_BASE_URL).toBe('https://dev.api.sandchest.com')
  })
})

// ---------------------------------------------------------------------------
// 5. Infra Config — Node Daemon
// ---------------------------------------------------------------------------

describe('infra: node daemon config', () => {
  test('production uses c8i.4xlarge, dev uses c8i.2xlarge', () => {
    expect(getNodeInstanceType('production')).toBe('c8i.4xlarge')
    expect(getNodeInstanceType('dev')).toBe('c8i.2xlarge')
  })

  test('root volume is 100 GB for production, 50 GB for dev', () => {
    expect(getNodeRootVolumeGb('production')).toBe(100)
    expect(getNodeRootVolumeGb('dev')).toBe(50)
  })

  test('gRPC port is 50051', () => {
    expect(getNodeGrpcPort()).toBe(50051)
  })

  test('AMI SSM parameter returns valid path', () => {
    const param = getNodeAmiSsmParameter()
    expect(param).toContain('/aws/service/ami-amazon-linux-latest/')
    expect(param).toContain('x86_64')
  })

  test('node environment includes required variables', () => {
    const env = getNodeEnvironment('production', 'my-bucket')
    expect(env.RUST_LOG).toBe('info')
    expect(env.SANDCHEST_DATA_DIR).toBe('/var/sandchest')
    expect(env.SANDCHEST_NODE_GRPC_PORT).toBe('50051')
    expect(env.SANDCHEST_JAILER_ENABLED).toBe('true')
    expect(env.SANDCHEST_S3_BUCKET).toBe('my-bucket')
    expect(env.SANDCHEST_S3_REGION).toBe('us-east-1')
    expect(env.SANDCHEST_OUTBOUND_IFACE).toBe('ens5')
  })

  test('dev environment uses debug logging and disables jailer', () => {
    const env = getNodeEnvironment('dev', 'dev-bucket')
    expect(env.RUST_LOG).toBe('debug')
    expect(env.SANDCHEST_JAILER_ENABLED).toBe('false')
    expect(env.SANDCHEST_BANDWIDTH_MBPS).toBe('100')
  })

  test('systemd unit configures service correctly', () => {
    const unit = getNodeSystemdUnit()
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('[Install]')
    expect(unit).toContain('User=sandchest')
    expect(unit).toContain('EnvironmentFile=/etc/sandchest/node.env')
    expect(unit).toContain('ExecStart=/usr/local/bin/sandchest-node')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('LimitNOFILE=65536')
    expect(unit).toContain('CAP_NET_ADMIN')
  })

  test('user data creates system user and data directories', () => {
    const userData = getNodeUserData('dev', 'test-bucket')
    expect(userData).toContain('#!/bin/bash')
    expect(userData).toContain('useradd --system')
    expect(userData).toContain('/var/sandchest')
    expect(userData).toContain('mkdir -p /var/sandchest')
    expect(userData).toContain('/etc/sandchest/node.env')
    expect(userData).toContain('systemctl daemon-reload')
    expect(userData).toContain('systemctl enable sandchest-node.service')
  })

  test('user data includes environment file content', () => {
    const userData = getNodeUserData('production', 'prod-bucket')
    expect(userData).toContain('SANDCHEST_S3_BUCKET=prod-bucket')
    expect(userData).toContain('RUST_LOG=info')
    expect(userData).toContain('SANDCHEST_NODE_GRPC_PORT=50051')
  })

  test('user data enables SSM agent', () => {
    const userData = getNodeUserData('dev', 'bucket')
    expect(userData).toContain('amazon-ssm-agent')
  })
})

// ---------------------------------------------------------------------------
// 6. Infra Config — OIDC
// ---------------------------------------------------------------------------

describe('infra: GitHub OIDC config', () => {
  test('OIDC provider URL is correct', () => {
    expect(GITHUB_OIDC_PROVIDER_URL).toBe('https://token.actions.githubusercontent.com')
  })

  test('OIDC audience is sts.amazonaws.com', () => {
    expect(GITHUB_OIDC_AUDIENCE).toBe('sts.amazonaws.com')
  })

  test('OIDC thumbprints are non-empty', () => {
    expect(GITHUB_OIDC_THUMBPRINTS.length).toBeGreaterThan(0)
    for (const thumb of GITHUB_OIDC_THUMBPRINTS) {
      expect(thumb).toMatch(/^[a-f0-9]{40}$/)
    }
  })

  test('GitHub repo is set', () => {
    expect(GITHUB_REPO).toBeTruthy()
    expect(GITHUB_REPO).toContain('/')
  })

  test('deploy role name includes stage', () => {
    expect(getDeployRoleName('dev')).toBe('sandchest-deploy-dev')
    expect(getDeployRoleName('production')).toBe('sandchest-deploy-production')
  })

  test('trust policy allows OIDC web identity assumption', () => {
    const policy = getDeployRoleTrustPolicy('arn:aws:iam::12345:oidc-provider/test', 'org/repo')
    const statement = (policy.Statement as Array<Record<string, unknown>>)[0]
    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity')
    expect(statement.Effect).toBe('Allow')
  })

  test('trust policy scopes to correct repo', () => {
    const policy = getDeployRoleTrustPolicy('arn:test', 'CapSoftware/Sandchest')
    const statement = (policy.Statement as Array<Record<string, unknown>>)[0]
    const condition = statement.Condition as Record<string, Record<string, string>>
    expect(condition.StringLike).toBeDefined()
    const subKey = Object.keys(condition.StringLike).find((k) => k.endsWith(':sub'))
    expect(subKey).toBeDefined()
    expect(condition.StringLike[subKey!]).toContain('CapSoftware/Sandchest')
  })
})

// ---------------------------------------------------------------------------
// 7. Infra Config — CloudWatch Alarms
// ---------------------------------------------------------------------------

describe('infra: CloudWatch alarms', () => {
  test('SNS topic name includes stage', () => {
    expect(getSnsTopicName('dev')).toBe('sandchest-alarms-dev')
    expect(getSnsTopicName('production')).toBe('sandchest-alarms-production')
  })

  test('ECS running task alarm has correct thresholds', () => {
    const prod = getEcsRunningTaskAlarm('production')
    const dev = getEcsRunningTaskAlarm('dev')
    expect(prod.threshold).toBe(2)
    expect(dev.threshold).toBe(1)
    expect(prod.comparisonOperator).toBe('LessThanThreshold')
    expect(prod.treatMissingData).toBe('breaching')
  })

  test('ECS CPU alarm fires at correct threshold', () => {
    const prod = getEcsCpuAlarm('production')
    const dev = getEcsCpuAlarm('dev')
    expect(prod.threshold).toBe(85)
    expect(dev.threshold).toBe(90)
    expect(prod.namespace).toBe('AWS/ECS')
  })

  test('ECS memory alarm fires at correct threshold', () => {
    const prod = getEcsMemoryAlarm('production')
    expect(prod.threshold).toBe(85)
    expect(prod.metricName).toBe('MemoryUtilization')
  })

  test('ALB 5xx alarm is tighter in production', () => {
    const prod = getAlb5xxAlarm('production')
    const dev = getAlb5xxAlarm('dev')
    expect(prod.threshold).toBe(10)
    expect(dev.threshold).toBe(50)
    expect(prod.namespace).toBe('AWS/ApplicationELB')
  })

  test('ALB response time alarm is tighter in production', () => {
    const prod = getAlbResponseTimeAlarm('production')
    const dev = getAlbResponseTimeAlarm('dev')
    expect(prod.threshold).toBe(2)
    expect(dev.threshold).toBe(5)
  })

  test('ALB unhealthy host alarm fires on any unhealthy host', () => {
    const alarm = getAlbUnhealthyHostAlarm()
    expect(alarm.threshold).toBe(0)
    expect(alarm.comparisonOperator).toBe('GreaterThanThreshold')
  })

  test('Redis memory alarm fires at correct threshold', () => {
    const prod = getRedisMemoryAlarm('production')
    const dev = getRedisMemoryAlarm('dev')
    expect(prod.threshold).toBe(80)
    expect(dev.threshold).toBe(90)
    expect(prod.namespace).toBe('AWS/ElastiCache')
  })

  test('Redis eviction alarm is zero-tolerance in production', () => {
    const prod = getRedisEvictionAlarm('production')
    expect(prod.threshold).toBe(0)
    expect(prod.metricName).toBe('Evictions')
  })

  test('node heartbeat alarm uses custom namespace', () => {
    const alarm = getNodeHeartbeatAlarm()
    expect(alarm.namespace).toBe(NODE_HEARTBEAT_NAMESPACE)
    expect(alarm.metricName).toBe(NODE_HEARTBEAT_METRIC)
    expect(alarm.treatMissingData).toBe('breaching')
    expect(NODE_HEARTBEAT_NAMESPACE).toBe('Sandchest/Node')
  })

  test('all alarms have valid configurations', () => {
    const alarms = [
      getEcsRunningTaskAlarm('production'),
      getEcsCpuAlarm('production'),
      getEcsMemoryAlarm('production'),
      getAlb5xxAlarm('production'),
      getAlbResponseTimeAlarm('production'),
      getAlbUnhealthyHostAlarm(),
      getRedisMemoryAlarm('production'),
      getRedisEvictionAlarm('production'),
      getNodeHeartbeatAlarm(),
    ]
    for (const alarm of alarms) {
      expect(alarm.namespace).toBeTruthy()
      expect(alarm.metricName).toBeTruthy()
      expect(alarm.period).toBeGreaterThan(0)
      expect(alarm.evaluationPeriods).toBeGreaterThan(0)
      expect(alarm.description).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Infra Config — App
// ---------------------------------------------------------------------------

describe('infra: app config', () => {
  test('app name is sandchest', () => {
    const config = getAppConfig('production')
    expect(config.name).toBe('sandchest')
  })

  test('uses AWS as home provider in us-east-1', () => {
    const config = getAppConfig('production')
    expect(config.home).toBe('aws')
    expect(config.providers.aws.region).toBe('us-east-1')
  })

  test('production retains resources and enables protection', () => {
    const config = getAppConfig('production')
    expect(config.removal).toBe('retain')
    expect(config.protect).toBe(true)
  })

  test('dev removes resources and disables protection', () => {
    const config = getAppConfig('dev')
    expect(config.removal).toBe('remove')
    expect(config.protect).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. SST Environment Resolution
// ---------------------------------------------------------------------------

describe('smoke: SST environment resolution', () => {
  const originalEnv = { ...process.env }

  afterAll(() => {
    process.env = { ...originalEnv }
  })

  test('sstResource parses SST-linked Redis config', () => {
    process.env.SST_RESOURCE_Redis = JSON.stringify({ host: 'redis.internal', port: 6379 })
    const result = sstResource<{ host: string; port: number }>('Redis')
    expect(result).toEqual({ host: 'redis.internal', port: 6379 })
    delete process.env.SST_RESOURCE_Redis
  })

  test('sstResource parses SST-linked bucket config', () => {
    process.env.SST_RESOURCE_ArtifactBucket = JSON.stringify({ name: 'my-bucket' })
    const result = sstResource<{ name: string }>('ArtifactBucket')
    expect(result?.name).toBe('my-bucket')
    delete process.env.SST_RESOURCE_ArtifactBucket
  })

  test('sstResource handles missing gracefully', () => {
    delete process.env.SST_RESOURCE_Missing
    expect(sstResource('Missing')).toBeUndefined()
  })

  test('sstResource handles malformed JSON gracefully', () => {
    process.env.SST_RESOURCE_Bad = 'not-json'
    expect(sstResource('Bad')).toBeUndefined()
    delete process.env.SST_RESOURCE_Bad
  })
})

// ---------------------------------------------------------------------------
// 10. Redis Operations Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: Redis operations', () => {
  let redis: RedisApi

  beforeEach(() => {
    redis = createInMemoryRedisApi()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  test('ping returns true', async () => {
    expect(await run(redis.ping())).toBe(true)
  })

  test('slot lease acquire/release cycle', async () => {
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_1', 60))).toBe(true)
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_2', 60))).toBe(false)
    await run(redis.releaseSlotLease('n1', 0))
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_2', 60))).toBe(true)
  })

  test('rate limiter enforces limits', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await run(redis.checkRateLimit('org', 'create', 3, 60))
      expect(r.allowed).toBe(true)
    }
    const denied = await run(redis.checkRateLimit('org', 'create', 3, 60))
    expect(denied.allowed).toBe(false)
  })

  test('event buffering round-trip', async () => {
    const event: BufferedEvent = { seq: 1, ts: '2026-01-01T00:00:00Z', data: { type: 'stdout' } }
    await run(redis.pushExecEvent('ex_1', event, 300))
    const events = await run(redis.getExecEvents('ex_1', 0))
    expect(events).toEqual([event])
  })

  test('node heartbeat register and check', async () => {
    expect(await run(redis.hasNodeHeartbeat('node_1'))).toBe(false)
    await run(redis.registerNodeHeartbeat('node_1', 60))
    expect(await run(redis.hasNodeHeartbeat('node_1'))).toBe(true)
  })

  test('leader election acquires lock', async () => {
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_1', 5000))).toBe(true)
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_2', 5000))).toBe(false)
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_1', 5000))).toBe(true)
  })

  test('artifact paths add and retrieve', async () => {
    await run(redis.addArtifactPaths('sb_1', ['/tmp/a.txt', '/tmp/b.txt']))
    const paths = await run(redis.getArtifactPaths('sb_1'))
    expect(paths).toContain('/tmp/a.txt')
    expect(paths).toContain('/tmp/b.txt')
    expect(await run(redis.countArtifactPaths('sb_1'))).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 11. S3 Object Storage Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: S3 object storage operations', () => {
  let storage: ObjectStorageApi

  beforeEach(() => {
    storage = createInMemoryObjectStorage()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  test('put and get object round-trip', async () => {
    await run(storage.putObject('artifacts/test.txt', 'hello world'))
    const content = await run(storage.getObject('artifacts/test.txt'))
    expect(content).toBe('hello world')
  })

  test('get non-existent object returns null', async () => {
    const content = await run(storage.getObject('missing/key'))
    expect(content).toBeNull()
  })

  test('delete removes object', async () => {
    await run(storage.putObject('tmp/upload.bin', 'data'))
    await run(storage.deleteObject('tmp/upload.bin'))
    const content = await run(storage.getObject('tmp/upload.bin'))
    expect(content).toBeNull()
  })

  test('presigned URL contains key and expiration', async () => {
    const url = await run(storage.getPresignedUrl('events/log.json', 3600))
    expect(url).toContain('events/log.json')
    expect(url).toContain('3600')
  })

  test('put overwrites existing object', async () => {
    await run(storage.putObject('key', 'v1'))
    await run(storage.putObject('key', 'v2'))
    const content = await run(storage.getObject('key'))
    expect(content).toBe('v2')
  })

  test('binary data round-trip via Uint8Array', async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111])
    await run(storage.putObject('bin/data', data))
    const content = await run(storage.getObject('bin/data'))
    expect(content).toBe('Hello')
  })
})

// ---------------------------------------------------------------------------
// 12. Node Client (gRPC Stub) Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: node client gRPC operations', () => {
  let nodeClient: NodeClientApi

  beforeEach(() => {
    nodeClient = createInMemoryNodeClient()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const sandboxId = new Uint8Array(16)

  test('exec returns successful result', async () => {
    const result = await run(
      nodeClient.exec({
        sandboxId,
        execId: 'ex_1',
        cmd: ['echo', 'hello'],
        cwd: '/work',
        env: {},
        timeoutSeconds: 30,
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.cpuMs).toBeGreaterThanOrEqual(0)
    expect(result.peakMemoryBytes).toBeGreaterThanOrEqual(0)
  })

  test('session lifecycle: create, exec, input, destroy', async () => {
    await run(
      nodeClient.createSession({
        sandboxId,
        sessionId: 'sess_1',
        shell: '/bin/bash',
        env: {},
      }),
    )

    const execResult = await run(
      nodeClient.sessionExec({
        sandboxId,
        sessionId: 'sess_1',
        cmd: 'ls',
        timeoutSeconds: 10,
      }),
    )
    expect(execResult.exitCode).toBe(0)

    await run(
      nodeClient.sessionInput({
        sandboxId,
        sessionId: 'sess_1',
        data: 'echo test\n',
      }),
    )

    await run(
      nodeClient.destroySession({
        sandboxId,
        sessionId: 'sess_1',
      }),
    )
  })

  test('file operations: put, get, list, delete', async () => {
    const data = new TextEncoder().encode('file content')

    const { bytesWritten } = await run(
      nodeClient.putFile({ sandboxId, path: '/work/test.txt', data }),
    )
    expect(bytesWritten).toBe(data.length)

    const retrieved = await run(
      nodeClient.getFile({ sandboxId, path: '/work/test.txt' }),
    )
    expect(new TextDecoder().decode(retrieved)).toBe('file content')

    const files = await run(
      nodeClient.listFiles({ sandboxId, path: '/work' }),
    )
    expect(files.length).toBeGreaterThan(0)

    await run(nodeClient.deleteFile({ sandboxId, path: '/work/test.txt' }))
  })

  test('fork sandbox completes without error', async () => {
    await run(
      nodeClient.forkSandbox({
        sourceSandboxId: sandboxId,
        newSandboxId: new Uint8Array(16).fill(1),
      }),
    )
  })

  test('collect artifacts returns results for existing files', async () => {
    const data = new TextEncoder().encode('artifact data')
    await run(nodeClient.putFile({ sandboxId, path: '/work/output.txt', data }))

    const artifacts = await run(
      nodeClient.collectArtifacts({
        sandboxId,
        paths: ['/work/output.txt'],
      }),
    )
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].name).toBe('output.txt')
    expect(artifacts[0].bytes).toBe(data.length)
  })
})

// ---------------------------------------------------------------------------
// 13. API Health Endpoints — Full HTTP Stack
// ---------------------------------------------------------------------------

describe('smoke: API health endpoints (full HTTP stack)', () => {
  let scope: Scope.CloseableScope
  let baseUrl: string

  const withTestAuth = HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (
        request.url.startsWith('/health') ||
        request.url.startsWith('/readyz')
      ) {
        return yield* Effect.provideService(app, AuthContext, {
          userId: '',
          orgId: '',
          scopes: null,
        })
      }
      return yield* Effect.provideService(app, AuthContext, {
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: null,
      })
    }),
  )

  beforeAll(async () => {
    const nodeServer = createServer()
    const quotaApi = createInMemoryQuotaApi() as QuotaApi & {
      setOrgQuota: (orgId: string, quota: Record<string, number>) => void
    }
    quotaApi.setOrgQuota(TEST_ORG, { maxConcurrentSandboxes: 100 })

    const TestApp = ApiRouter.pipe(
      withRateLimit,
      withTestAuth,
      withRequestId,
      withSecurityHeaders,
      HttpServer.serve(),
    )

    const services = Layer.mergeAll(
      Layer.succeed(SandboxRepo, createInMemorySandboxRepo()),
      Layer.succeed(ExecRepo, createInMemoryExecRepo()),
      Layer.succeed(SessionRepo, createInMemorySessionRepo()),
      Layer.succeed(ObjectStorage, createInMemoryObjectStorage()),
      Layer.succeed(NodeClient, createInMemoryNodeClient()),
      Layer.succeed(ArtifactRepo, createInMemoryArtifactRepo()),
      Layer.succeed(RedisService, createInMemoryRedisApi()),
      Layer.succeed(QuotaService, quotaApi),
      Layer.succeed(BillingService, createInMemoryBillingApi()),
      Layer.succeed(AuditLog, createInMemoryAuditLog()),
    )

    const FullLayer = TestApp.pipe(
      Layer.provide(services),
      Layer.provide(ShutdownControllerLive),
      Layer.provide(NodeHttpServer.layer(() => nodeServer, { port: 0 })),
      Layer.provide(JsonLoggerLive),
    )

    scope = Effect.runSync(Scope.make())
    await Effect.runPromise(Layer.buildWithScope(FullLayer, scope))

    const addr = nodeServer.address() as AddressInfo
    baseUrl = `http://localhost:${addr.port}`
  })

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test('GET /health returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /healthz returns 200 ok (ALB target)', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /readyz returns 200 with component checks', async () => {
    const res = await fetch(`${baseUrl}/readyz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      checks: { redis: string; shutdown: string }
    }
    expect(body.status).toBe('ok')
    expect(body.checks.redis).toBe('ok')
    expect(body.checks.shutdown).toBe('ok')
  })

  test('health endpoints include security headers', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  test('health endpoints respond quickly', async () => {
    const start = performance.now()
    await fetch(`${baseUrl}/healthz`)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000)
  })
})
