import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
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

    const grpcAddr = `${server.ip}:50051`

    // Write certs to local filesystem for local dev.
    // In production, the API on Fly.io uses MTLS_*_PEM env vars (inline PEM content).
    // Locally, the API reads certs from file paths via NODE_GRPC_*_PATH env vars.
    // When mTLS certs are regenerated on the node, these local files must be updated
    // too — otherwise the API's gRPC client holds stale certs and the mTLS handshake
    // fails with "UNAVAILABLE: No connection established".
    const localCaPath = process.env.NODE_GRPC_CA_PATH
    const localCertPath = process.env.NODE_GRPC_CERT_PATH
    const localKeyPath = process.env.NODE_GRPC_KEY_PATH

    if (localCaPath && localCertPath && localKeyPath) {
      try {
        await Promise.all([
          writeFile(localCaPath, ca + '\n'),
          writeFile(localCertPath, clientCert + '\n'),
          writeFile(localKeyPath, clientKey + '\n', { mode: 0o600 }),
        ])
      } catch (fsErr) {
        return NextResponse.json({
          error: `Certs generated on node but failed to write locally: ${fsErr instanceof Error ? fsErr.message : String(fsErr)}`,
        }, { status: 500 })
      }
    }

    // Try to auto-set Fly secrets if FLY_ACCESS_TOKEN is available
    const flyToken = process.env.FLY_ACCESS_TOKEN
    const flyApp = process.env.FLY_APP_NAME ?? 'sandchest-api'

    if (flyToken) {
      const secrets: Record<string, string> = {
        NODE_GRPC_ADDR: grpcAddr,
        MTLS_CA_PEM: ca,
        MTLS_CLIENT_CERT_PEM: clientCert,
        MTLS_CLIENT_KEY_PEM: clientKey,
      }

      const flyRes = await fetch(`https://api.machines.dev/v1/apps/${flyApp}/secrets`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${flyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          Object.entries(secrets).map(([label, value]) => ({
            label,
            value: Buffer.from(value).toString('base64'),
            type: 'secret',
          })),
        ),
      })

      if (!flyRes.ok) {
        const flyErr = await flyRes.text()
        return NextResponse.json({
          success: true,
          flySecretsSet: false,
          flyError: flyErr,
          flyCommand: `fly secrets set NODE_GRPC_ADDR='${grpcAddr}' MTLS_CA_PEM='${ca}' MTLS_CLIENT_CERT_PEM='${clientCert}' MTLS_CLIENT_KEY_PEM='${clientKey}' -a ${flyApp}`,
        })
      }

      return NextResponse.json({
        success: true,
        flySecretsSet: true,
        localCertsWritten: !!(localCaPath && localCertPath && localKeyPath),
      })
    }

    // No Fly token — return manual command
    return NextResponse.json({
      success: true,
      flySecretsSet: false,
      localCertsWritten: !!(localCaPath && localCertPath && localKeyPath),
      flyCommand: `fly secrets set NODE_GRPC_ADDR='${grpcAddr}' MTLS_CA_PEM='${ca}' MTLS_CLIENT_CERT_PEM='${clientCert}' MTLS_CLIENT_KEY_PEM='${clientKey}' -a ${flyApp}`,
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
