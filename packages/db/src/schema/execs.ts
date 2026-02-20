import { bigint, index, int, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, updatedAt, uuidv7Binary } from '../columns'

export const execs = mysqlTable(
  'execs',
  {
    id: uuidv7Binary('id').primaryKey(),
    sandboxId: uuidv7Binary('sandbox_id').notNull(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    sessionId: uuidv7Binary('session_id'),
    seq: int('seq').notNull(),
    cmd: text('cmd').notNull(),
    cmdFormat: mysqlEnum('cmd_format', ['array', 'shell']).notNull().default('array'),
    cwd: varchar('cwd', { length: 1024 }),
    env: json('env'),
    status: mysqlEnum('status', ['queued', 'running', 'done', 'failed', 'timed_out'])
      .notNull()
      .default('queued'),
    exitCode: int('exit_code'),
    cpuMs: bigint('cpu_ms', { mode: 'number' }),
    peakMemoryBytes: bigint('peak_memory_bytes', { mode: 'number' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    logRef: varchar('log_ref', { length: 1024 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestampMicro('started_at'),
    endedAt: timestampMicro('ended_at'),
  },
  (t) => [index('idx_sandbox_seq').on(t.sandboxId, t.seq)],
)
