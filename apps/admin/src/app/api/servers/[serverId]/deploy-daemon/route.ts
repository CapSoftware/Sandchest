import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import type { Client } from 'ssh2'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import type { SshConfig } from '@/lib/ssh'
import { presignDaemonBinary, presignKernel, presignRootfs } from '@/lib/r2'
import { firecrackerInstallCommands, patchAllRootfsCommands, rootfsPath, kernelPath } from '@/lib/provisioner'
import { generateId, idToBytes, bytesToId, NODE_PREFIX, TOOLCHAINS } from '@sandchest/contract'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Ensure /dev/vhost-vsock is available on the remote server.
 *
 * Strategy:
 * 1. Try `modprobe vhost_vsock` — works if the running kernel has the module.
 * 2. If missing, install `linux-image-amd64` (Debian stock kernel ships vsock).
 * 3. Retry modprobe — sometimes the new modules load on the running kernel.
 * 4. If still missing, the running kernel is incompatible (e.g. Hetzner 6.12.x).
 *    Move the old kernel aside so GRUB defaults to the Debian one, then reboot.
 * 5. Wait for SSH to come back, reconnect, verify vsock.
 *
 * Returns the (possibly new) SSH connection and a log of what happened.
 */
async function ensureVsockAvailable(
  conn: Client,
  sshConfig: SshConfig,
): Promise<{ conn: Client; log: string }> {
  const logs: string[] = []

  // 1. Fast path — module already loadable
  const check = await execCommand(
    conn,
    'modprobe vhost_vsock 2>/dev/null && test -e /dev/vhost-vsock && echo VSOCK_OK',
    30_000,
  )
  if (check.stdout.includes('VSOCK_OK')) {
    // Ensure persistence
    await execCommand(
      conn,
      'grep -q vhost_vsock /etc/modules-load.d/sandchest.conf 2>/dev/null || echo vhost_vsock >> /etc/modules-load.d/sandchest.conf',
      10_000,
    )
    logs.push('[vsock] module loaded on running kernel')
    return { conn, log: logs.join('\n') }
  }

  // 2. Install Debian stock kernel
  logs.push('[vsock] module missing — installing linux-image-amd64')
  const install = await execCommand(conn, [
    'DEBIAN_FRONTEND=noninteractive apt-get update -qq',
    'apt-get install -y -qq linux-image-amd64',
  ].join(' && '), 300_000)
  if (install.code !== 0) {
    throw new Error(`Kernel install failed: ${(install.stdout + '\n' + install.stderr).trim()}`)
  }

  // 3. Maybe the new modules load on the running kernel
  const retry = await execCommand(
    conn,
    'modprobe vhost_vsock 2>/dev/null && test -e /dev/vhost-vsock && echo VSOCK_OK',
    30_000,
  )
  if (retry.stdout.includes('VSOCK_OK')) {
    await execCommand(
      conn,
      'grep -q vhost_vsock /etc/modules-load.d/sandchest.conf 2>/dev/null || echo vhost_vsock >> /etc/modules-load.d/sandchest.conf',
      10_000,
    )
    logs.push('[vsock] module loaded after kernel package install (no reboot needed)')
    return { conn, log: logs.join('\n') }
  }

  // 4. Reboot required — set Debian kernel as GRUB default
  logs.push('[vsock] reboot required — configuring GRUB for Debian kernel')
  const rebootPrep = await execCommand(conn, [
    // Persist all required modules for after reboot
    'printf "kvm\\ntun\\nvhost_vsock\\n" > /etc/modules-load.d/sandchest.conf',
    // Move the current (non-Debian) kernel aside so GRUB defaults to the Debian one
    'CURRENT=$(uname -r)',
    'DEBIAN_K=$(ls /boot/vmlinuz-*-amd64 2>/dev/null | sort -V | tail -1 | sed "s|/boot/vmlinuz-||")',
    'if [ -n "$DEBIAN_K" ] && [ "$CURRENT" != "$DEBIAN_K" ]; then '
      + 'for f in vmlinuz initrd.img config System.map; do '
      + 'test -f "/boot/$f-$CURRENT" && mv "/boot/$f-$CURRENT" "/boot/$f-$CURRENT.bak"; '
      + 'done && update-grub && echo "GRUB_UPDATED"; fi',
  ].join(' && '), 60_000)
  logs.push(`[vsock] GRUB prep: ${rebootPrep.stdout.trim()}`)

  // Schedule reboot (detached so the SSH command returns)
  await execCommand(conn, 'nohup bash -c "sleep 2 && reboot" &>/dev/null &', 10_000)
  conn.end()
  logs.push('[vsock] reboot initiated — waiting for server')

  // 5. Wait for SSH to come back (15s settle + poll every 5s for up to 5 min)
  await sleep(20_000)
  let newConn: Client | null = null
  for (let attempt = 0; attempt < 54; attempt++) {
    await sleep(5_000)
    try {
      newConn = await createSshConnection({ ...sshConfig, readyTimeout: 10_000 })
      break
    } catch {
      // Still rebooting
    }
  }
  if (!newConn) {
    throw new Error('Server did not come back within 5 minutes after kernel reboot')
  }
  logs.push('[vsock] server back online after reboot')

  // 6. Load module on the new kernel
  const postReboot = await execCommand(
    newConn,
    'modprobe vhost_vsock && test -e /dev/vhost-vsock && echo VSOCK_OK',
    30_000,
  )
  if (!postReboot.stdout.includes('VSOCK_OK')) {
    const kernel = await execCommand(newConn, 'uname -r', 5_000)
    newConn.end()
    throw new Error(
      `vhost_vsock still unavailable after reboot (kernel: ${kernel.stdout.trim()}). `
      + 'The server may need a manual kernel configuration.',
    )
  }

  logs.push(`[vsock] module loaded successfully after reboot`)
  return { conn: newConn, log: logs.join('\n') }
}

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

  const sshConfig: SshConfig = {
    host: server.ip,
    port: server.sshPort,
    username: server.sshUser,
    privateKey: sshKey,
  }

  let conn: Client
  try {
    conn = await createSshConnection(sshConfig)
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
    // --- Phase 1: Ensure vsock kernel module is available ---
    // This may install a kernel package and reboot the server automatically.
    // If a reboot happens, `conn` is replaced with a fresh SSH connection.
    const vsock = await ensureVsockAvailable(conn, sshConfig)
    conn = vsock.conn
    const vsockLog = vsock.log

    // --- Phase 2: Deploy daemon (images, binaries, config, restart) ---
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
      const output = (vsockLog + '\n' + result.stdout + '\n' + result.stderr).trim()
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
      output: (vsockLog + '\n' + result.stdout + '\n' + result.stderr).trim(),
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
