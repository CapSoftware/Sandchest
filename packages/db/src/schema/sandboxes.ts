import { boolean, index, int, json, mysqlEnum, mysqlTable, smallint, tinyint, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, updatedAt, uuidv7Binary } from '../columns'

export const sandboxes = mysqlTable(
  'sandboxes',
  {
    id: uuidv7Binary('id').primaryKey(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    nodeId: uuidv7Binary('node_id'),
    imageId: uuidv7Binary('image_id').notNull(),
    profileId: uuidv7Binary('profile_id').notNull(),
    profileName: varchar('profile_name', { length: 32 }).notNull(),
    status: mysqlEnum('status', [
      'queued',
      'provisioning',
      'running',
      'stopping',
      'stopped',
      'failed',
      'deleted',
    ])
      .notNull()
      .default('queued'),
    env: json('env'),
    forkedFrom: uuidv7Binary('forked_from'),
    forkDepth: tinyint('fork_depth').notNull().default(0),
    forkCount: smallint('fork_count').notNull().default(0),
    ttlSeconds: int('ttl_seconds').notNull().default(3600),
    replayPublic: boolean('replay_public').notNull().default(false),
    failureReason: mysqlEnum('failure_reason', [
      'capacity_timeout',
      'node_lost',
      'provision_failed',
      'sandbox_stopped',
      'sandbox_deleted',
      'ttl_exceeded',
      'idle_timeout',
      'queue_timeout',
    ]),
    replayBundleRef: varchar('replay_bundle_ref', { length: 1024 }),
    replayExpiresAt: timestampMicro('replay_expires_at'),
    lastActivityAt: timestampMicro('last_activity_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestampMicro('started_at'),
    endedAt: timestampMicro('ended_at'),
  },
  (t) => [
    index('idx_org_status_created').on(t.orgId, t.status, t.createdAt),
    index('idx_org_created').on(t.orgId, t.createdAt),
    index('idx_node_status').on(t.nodeId, t.status),
    index('idx_status_ended').on(t.status, t.endedAt),
    index('idx_forked_from').on(t.forkedFrom),
  ],
)
