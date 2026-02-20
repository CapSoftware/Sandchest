import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, updatedAt } from '../columns'

export const orgQuotas = mysqlTable('org_quotas', {
  orgId: varchar('org_id', { length: 36 }).primaryKey(),
  maxConcurrentSandboxes: int('max_concurrent_sandboxes').notNull().default(10),
  maxTtlSeconds: int('max_ttl_seconds').notNull().default(14400),
  maxExecTimeoutSeconds: int('max_exec_timeout_seconds').notNull().default(7200),
  artifactRetentionDays: int('artifact_retention_days').notNull().default(30),
  rateSandboxCreatePerMin: int('rate_sandbox_create_per_min').notNull().default(30),
  rateExecPerMin: int('rate_exec_per_min').notNull().default(120),
  rateReadPerMin: int('rate_read_per_min').notNull().default(600),
  idleTimeoutSeconds: int('idle_timeout_seconds').notNull().default(900),
  maxForkDepth: int('max_fork_depth').notNull().default(5),
  maxForksPerSandbox: int('max_forks_per_sandbox').notNull().default(10),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})
