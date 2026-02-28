import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { METRICS_SCRIPT, parseMetrics, type MetricsResult } from '@/lib/metrics'

async function collectServerMetrics(server: {
  id: Uint8Array
  ip: string
  sshPort: number
  sshUser: string
  sshKeyEncrypted: string
  sshKeyIv: string
  sshKeyTag: string
}): Promise<MetricsResult> {
  const fallback: MetricsResult = {
    metrics: null,
    daemon_status: 'unknown',
    collected_at: new Date().toISOString(),
  }

  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return fallback
  }

  let conn
  try {
    conn = await createSshConnection({
      host: server.ip,
      port: server.sshPort,
      username: server.sshUser,
      privateKey: sshKey,
      readyTimeout: 5_000,
    })
  } catch {
    return { ...fallback, daemon_status: 'unreachable' }
  }

  try {
    const result = await execCommand(conn, METRICS_SCRIPT)
    conn.end()
    if (result.code !== 0) return fallback
    return parseMetrics(result.stdout)
  } catch {
    conn.end()
    return fallback
  }
}

export async function GET() {
  const db = getDb()
  const rows = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.provisionStatus, 'completed'))

  const entries = await Promise.all(
    rows.map(async (row) => {
      const serverId = Buffer.from(row.id).toString('hex')
      const result = await collectServerMetrics(row)
      return [serverId, result] as const
    }),
  )

  const metrics: Record<string, MetricsResult> = Object.fromEntries(entries)

  return NextResponse.json({ metrics })
}
