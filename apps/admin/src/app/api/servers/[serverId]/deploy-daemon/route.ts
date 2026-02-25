import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { presignDaemonBinary } from '@/lib/r2'
import { generateId, idToBytes, NODE_PREFIX } from '@sandchest/contract'

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

  // Generate a stable node ID so we can link the daemon back to this server
  const nodeId = generateId(NODE_PREFIX)
  const nodeIdBytes = idToBytes(nodeId) as unknown as Uint8Array

  try {
    const commands = [
      `curl -fsSL '${binaryUrl}' -o /usr/local/bin/sandchest-node`,
      'chmod +x /usr/local/bin/sandchest-node',
      'mkdir -p /etc/sandchest',
      `printf 'SANDCHEST_NODE_ID=${nodeId}\\n' > /etc/sandchest/node.env`,
      // Ensure the systemd unit references the env file (idempotent — rewrites the unit)
      `printf '[Unit]\\nDescription=Sandchest Node Daemon\\nAfter=network.target\\n\\n[Service]\\nType=simple\\nExecStart=/usr/local/bin/sandchest-node\\nRestart=always\\nRestartSec=5\\nEnvironmentFile=-/etc/sandchest/node.env\\nEnvironment=RUST_LOG=info\\nEnvironment=DATA_DIR=/var/sandchest\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/sandchest-node.service`,
      'systemctl daemon-reload',
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

    // Link the daemon to the server record
    await db
      .update(adminServers)
      .set({ nodeId: nodeIdBytes, updatedAt: new Date() })
      .where(eq(adminServers.id, serverIdBuf))

    return NextResponse.json({
      success: true,
      node_id: nodeId,
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
