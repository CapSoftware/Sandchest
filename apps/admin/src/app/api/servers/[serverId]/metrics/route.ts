import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { METRICS_SCRIPT, parseMetrics } from '@/lib/metrics'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const db = getDb()

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  if (server.provisionStatus !== 'completed') {
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
  }

  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
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
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unreachable',
      collected_at: new Date().toISOString(),
    })
  }

  try {
    const result = await execCommand(conn, METRICS_SCRIPT)
    conn.end()

    if (result.code !== 0) {
      return NextResponse.json({
        metrics: null,
        daemon_status: 'unknown',
        collected_at: new Date().toISOString(),
      })
    }

    return NextResponse.json(parseMetrics(result.stdout))
  } catch {
    conn.end()
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
  }
}
