import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'

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
      // Stop the daemon so it doesn't restart VMs
      '(systemctl stop sandchest-node 2>/dev/null || true)',
      // Kill any remaining firecracker/jailer processes
      '(pkill -9 firecracker 2>/dev/null || true)',
      '(pkill -9 jailer 2>/dev/null || true)',
      // Clean up sandbox and jailer data directories
      'rm -rf /var/sandchest/sandboxes/*',
      'rm -rf /var/sandchest/jailer/*',
      // Remove any stale TAP devices
      'for tap in $(ip -o link show type tun | awk -F: \'{print $2}\' | tr -d " "); do ip link delete "$tap" 2>/dev/null || true; done',
      // Flush NAT rules for sandbox traffic (re-add the masquerade rule)
      'iptables -t nat -F POSTROUTING 2>/dev/null || true',
      'iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -j MASQUERADE 2>/dev/null || true',
      // Restart the daemon clean
      'systemctl start sandchest-node',
    ]

    const result = await execCommand(conn, commands.join(' && '), 30_000)

    if (result.code !== 0) {
      const output = (result.stdout + '\n' + result.stderr).trim()
      return NextResponse.json(
        { error: 'Cleanup failed', output },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      output: (result.stdout + '\n' + result.stderr).trim(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  } finally {
    conn.end()
  }
}
