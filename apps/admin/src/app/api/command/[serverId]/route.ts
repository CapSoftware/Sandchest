import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const body = await request.json() as { command?: string }

  if (!body.command || typeof body.command !== 'string') {
    return NextResponse.json({ error: 'command is required' }, { status: 400 })
  }

  const db = getDb()
  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))
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

  const start = Date.now()

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
      {
        stdout: '',
        stderr: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`,
        exit_code: -1,
        duration_ms: Date.now() - start,
      },
      { status: 200 },
    )
  }

  try {
    const result = await execCommand(conn, body.command)
    conn.end()

    return NextResponse.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.code,
      duration_ms: Date.now() - start,
    })
  } catch (err) {
    conn.end()
    return NextResponse.json({
      stdout: '',
      stderr: `Command execution error: ${err instanceof Error ? err.message : String(err)}`,
      exit_code: -1,
      duration_ms: Date.now() - start,
    })
  }
}
