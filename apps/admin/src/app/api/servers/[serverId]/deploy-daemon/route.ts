import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { presignDaemonBinary, presignKernel, presignRootfs } from '@/lib/r2'
import { firecrackerInstallCommands, patchAllRootfsCommands, rootfsPath, kernelPath } from '@/lib/provisioner'
import { generateId, idToBytes, bytesToId, NODE_PREFIX, TOOLCHAINS } from '@sandchest/contract'

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

  let binaryUrl: string
  let kernelUrl: string
  let rootfsUrls: Map<string, string>
  try {
    const [binary, kernel, ...rootfsList] = await Promise.all([
      presignDaemonBinary(),
      presignKernel(),
      ...TOOLCHAINS.map((tc) => presignRootfs(tc)),
    ])
    binaryUrl = binary
    kernelUrl = kernel
    rootfsUrls = new Map(TOOLCHAINS.map((tc, i) => [tc, rootfsList[i]]))
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

  // Reuse existing node ID on redeploy, generate new one for first deploy
  const isRedeploy = server.nodeId != null
  const nodeId = isRedeploy
    ? bytesToId(NODE_PREFIX, server.nodeId as unknown as Uint8Array)
    : generateId(NODE_PREFIX)
  const nodeIdBytes = isRedeploy
    ? server.nodeId as unknown as Uint8Array
    : idToBytes(nodeId) as unknown as Uint8Array

  try {
    const commands = [
      // Stop daemon and unmount any stale rootfs loop mounts
      '(systemctl stop sandchest-node 2>/dev/null || true)',
      '(umount /tmp/sandchest-rootfs-patch 2>/dev/null || true)',
      ...TOOLCHAINS.map((tc) => `(umount ${rootfsPath(tc)} 2>/dev/null || true)`),
      // Create directories for all toolchain images
      ...TOOLCHAINS.map((tc) => `mkdir -p /var/sandchest/images/ubuntu-22.04/${tc}`),
      // Download latest kernel
      `curl -fsSL --retry 3 --retry-delay 5 '${kernelUrl}' -o ${kernelPath()}`,
      `chmod 644 ${kernelPath()}`,
      // Download all toolchain rootfs images
      ...TOOLCHAINS.map((tc) =>
        `curl -fsSL --retry 3 --retry-delay 5 '${rootfsUrls.get(tc)}' -o ${rootfsPath(tc)} && chmod 644 ${rootfsPath(tc)}`
      ),
      // Patch all rootfs images with overlay-init + guest agent systemd unit
      ...patchAllRootfsCommands(),
      // Keep the host Firecracker/Jailer version aligned with the node binary expectations.
      ...firecrackerInstallCommands(),
      // Download latest daemon binary
      `curl -fsSL --retry 3 --retry-delay 5 '${binaryUrl}' -o /usr/local/bin/sandchest-node`,
      'chmod +x /usr/local/bin/sandchest-node',
      'mkdir -p /etc/sandchest',
      `printf 'SANDCHEST_NODE_ID=${nodeId}\\nSANDCHEST_KERNEL_PATH=${kernelPath()}\\nSANDCHEST_JAILER_ENABLED=1\\nSANDCHEST_JAILER_BINARY=/usr/local/bin/jailer\\nSANDCHEST_FIRECRACKER_BINARY=/usr/local/bin/firecracker\\n' > /etc/sandchest/node.env`,
      // Append TLS paths if mTLS certs exist on this server
      `test -f /etc/sandchest/certs/server.pem && printf 'SANDCHEST_GRPC_CERT=/etc/sandchest/certs/server.pem\\nSANDCHEST_GRPC_KEY=/etc/sandchest/certs/server.key\\nSANDCHEST_GRPC_CA=/etc/sandchest/certs/ca.pem\\n' >> /etc/sandchest/node.env || true`,
      // Ensure the systemd unit references the env file (idempotent — rewrites the unit)
      `printf '[Unit]\\nDescription=Sandchest Node Daemon\\nAfter=network.target\\n\\n[Service]\\nType=simple\\nExecStart=/usr/local/bin/sandchest-node\\nRestart=always\\nRestartSec=5\\nEnvironmentFile=-/etc/sandchest/node.env\\nEnvironment=RUST_LOG=info\\nEnvironment=SANDCHEST_DATA_DIR=/var/sandchest\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/sandchest-node.service`,
      'systemctl daemon-reload',
      'systemctl restart sandchest-node',
    ]

    const result = await execCommand(conn, commands.join(' && '), 600_000)

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

    // Register/upsert the node in the production API so sandbox queries work
    const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'
    const apiToken = process.env.ADMIN_API_TOKEN
    try {
      const registerRes = await fetch(`${apiUrl}/v1/admin/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
        },
        body: JSON.stringify({
          id: nodeId,
          name: server.name ?? server.ip,
          hostname: server.ip,
        }),
      })
      if (!registerRes.ok) {
        console.error(`[deploy] failed to register node in API: ${registerRes.status} ${await registerRes.text().catch(() => '')}`)
      }
    } catch (err) {
      console.error(`[deploy] node registration failed:`, err)
    }

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
