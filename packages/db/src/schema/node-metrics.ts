import { bigint, float, index, mysqlTable } from 'drizzle-orm/mysql-core'
import { createdAt, uuidv7Binary } from '../columns'

export const nodeMetrics = mysqlTable(
  'node_metrics',
  {
    id: uuidv7Binary('id').primaryKey(),
    nodeId: uuidv7Binary('node_id').notNull(),
    cpuPercent: float('cpu_percent').notNull(),
    memoryUsedBytes: bigint('memory_used_bytes', { mode: 'bigint' }).notNull(),
    memoryTotalBytes: bigint('memory_total_bytes', { mode: 'bigint' }).notNull(),
    diskUsedBytes: bigint('disk_used_bytes', { mode: 'bigint' }).notNull(),
    diskTotalBytes: bigint('disk_total_bytes', { mode: 'bigint' }).notNull(),
    networkRxBytes: bigint('network_rx_bytes', { mode: 'bigint' }).notNull(),
    networkTxBytes: bigint('network_tx_bytes', { mode: 'bigint' }).notNull(),
    loadAvg1: float('load_avg_1').notNull(),
    loadAvg5: float('load_avg_5').notNull(),
    loadAvg15: float('load_avg_15').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_node_metrics_node_id').on(t.nodeId),
    index('idx_node_metrics_created_at').on(t.createdAt),
  ],
)
