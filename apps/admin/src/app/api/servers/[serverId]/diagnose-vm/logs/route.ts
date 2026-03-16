import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'

/**
 * Fetch the last N lines of the sandchest-node daemon journal.
 * Useful for debugging gRPC connection issues, sandbox creation failures,
 * and guest agent health check timeouts.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const url = new URL(request.url)
  const lines = Math.min(parseInt(url.searchParams.get('lines') ?? '100', 10), 500)

  const db = getDb()
  const serverIdBuf = Buffer.from(serverId, 'hex') as unknown as Uint8Array

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, serverIdBuf))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt SSH key' }, { status: 500 })
  }

  let conn
  try {
    conn = await createSshConnection({
      host: server.ip,
      port: server.sshPort,
      username: server.sshUser,
      privateKey: sshKey,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    )
  }

  try {
    const result = await execCommand(
      conn,
      `journalctl -u sandchest-node --no-pager -n ${lines} 2>&1`,
      15_000,
    )

    return NextResponse.json({
      output: result.stdout.trim(),
      exitCode: result.code,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  } finally {
    conn.end()
  }
}
