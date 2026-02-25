import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { presignDaemonBinary } from '@/lib/r2'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
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

  if (server.provisionStatus !== 'completed') {
    return NextResponse.json(
      { error: 'Server must be fully provisioned before deploying daemon' },
      { status: 400 },
    )
  }

  let binaryUrl: string
  try {
    binaryUrl = await presignDaemonBinary()
  } catch (err) {
    return NextResponse.json(
      { error: `R2 presign failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
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
    const commands = [
      `curl -fsSL '${binaryUrl}' -o /usr/local/bin/sandchest-node`,
      'chmod +x /usr/local/bin/sandchest-node',
      'systemctl restart sandchest-node',
    ]

    const result = await execCommand(conn, commands.join(' && '))

    if (result.code !== 0) {
      const output = (result.stdout + '\n' + result.stderr).trim()
      return NextResponse.json(
        { error: 'Deploy failed', output },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      output: (result.stdout + '\n' + result.stderr).trim(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Deploy error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  } finally {
    conn.end()
  }
}
