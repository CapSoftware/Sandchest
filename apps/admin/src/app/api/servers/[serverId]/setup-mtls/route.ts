import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { mtlsCertCommands } from '@/lib/provisioner'

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
      { error: 'Server must be fully provisioned before setting up mTLS' },
      { status: 400 },
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
    // 1. Generate all mTLS certs
    const certCmds = mtlsCertCommands(server.ip)
    const certResult = await execCommand(conn, certCmds.join(' && '), 60_000)

    if (certResult.code !== 0) {
      const output = (certResult.stdout + '\n' + certResult.stderr).trim()
      return NextResponse.json({ error: 'Cert generation failed', output }, { status: 500 })
    }

    // 2. Append TLS env vars to node.env (preserving existing content)
    const envResult = await execCommand(conn, [
      // Remove any previous TLS lines to avoid duplicates
      "sed -i '/^SANDCHEST_GRPC_/d' /etc/sandchest/node.env",
      "printf 'SANDCHEST_GRPC_CERT=/etc/sandchest/certs/server.pem\\nSANDCHEST_GRPC_KEY=/etc/sandchest/certs/server.key\\nSANDCHEST_GRPC_CA=/etc/sandchest/certs/ca.pem\\n' >> /etc/sandchest/node.env",
    ].join(' && '))

    if (envResult.code !== 0) {
      return NextResponse.json(
        { error: 'Failed to update node.env', output: (envResult.stdout + '\n' + envResult.stderr).trim() },
        { status: 500 },
      )
    }

    // 3. Restart the daemon to pick up TLS config
    const restartResult = await execCommand(conn, 'systemctl restart sandchest-node')
    if (restartResult.code !== 0) {
      return NextResponse.json(
        { error: 'Failed to restart daemon', output: (restartResult.stdout + '\n' + restartResult.stderr).trim() },
        { status: 500 },
      )
    }

    // 4. Read back the client certs for Fly.io secrets
    const caResult = await execCommand(conn, 'cat /etc/sandchest/certs/ca.pem')
    const clientCertResult = await execCommand(conn, 'cat /etc/sandchest/certs/client.pem')
    const clientKeyResult = await execCommand(conn, 'cat /etc/sandchest/certs/client.key')

    if (caResult.code !== 0 || clientCertResult.code !== 0 || clientKeyResult.code !== 0) {
      return NextResponse.json({ error: 'Certs generated but failed to read them back' }, { status: 500 })
    }

    const ca = caResult.stdout.trim()
    const clientCert = clientCertResult.stdout.trim()
    const clientKey = clientKeyResult.stdout.trim()

    return NextResponse.json({
      success: true,
      certs: { ca, clientCert, clientKey },
      flyCommand: `fly secrets set MTLS_CA_PEM='${ca}' MTLS_CLIENT_CERT_PEM='${clientCert}' MTLS_CLIENT_KEY_PEM='${clientKey}' -a sandchest-api`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `mTLS setup error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  } finally {
    conn.end()
  }
}
