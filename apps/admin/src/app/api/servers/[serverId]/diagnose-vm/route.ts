import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'

/**
 * Boot an unjailed Firecracker VM and capture serial console output.
 *
 * This diagnostic reveals:
 * - Kernel boot failures or panics
 * - overlay-init script errors (the script that sets up overlayfs before systemd)
 * - Guest agent crash reasons (service is patched to log to ttyS0 for visibility)
 * - Whether the vsock socket file is created on the host
 *
 * The script creates a temporary copy of the base rootfs, patches the guest agent
 * systemd service to log directly to the serial console (removing journal redirect),
 * boots Firecracker unjailed for ~15s, then returns the output.
 *
 * Common issues this catches:
 * - ProtectSystem=strict in the guest agent service blocking vsock socket creation
 * - Missing guest agent binary in the rootfs (not baked in by build-images CI)
 * - Kernel missing vsock support (AF_VSOCK unavailable inside guest)
 * - Stale/corrupt rootfs images after failed patching
 */
const DIAGNOSE_SCRIPT = `#!/bin/bash
set -e
DIR=/tmp/fc-diag-$$
mkdir -p "$DIR"

# --- Pre-flight checks ---
echo "=== PRE-FLIGHT ==="
echo "kernel: $(ls -la /var/sandchest/images/vmlinux-5.10 2>/dev/null | awk '{print $5, $6, $7, $8}' || echo MISSING)"
echo "rootfs: $(ls -la /var/sandchest/images/ubuntu-22.04/base/rootfs.ext4 2>/dev/null | awk '{print $5, $6, $7, $8}' || echo MISSING)"
echo "firecracker: $(firecracker --version 2>&1 | head -1 || echo MISSING)"
echo "vsock host: $(test -e /dev/vhost-vsock && echo OK || echo MISSING)"
echo "daemon: $(systemctl is-active sandchest-node 2>/dev/null || echo unknown)"

# --- Copy image and kernel ---
cp --reflink=auto /var/sandchest/images/ubuntu-22.04/base/rootfs.ext4 "$DIR/rootfs.ext4"
cp /var/sandchest/images/vmlinux-5.10 "$DIR/vmlinux"

# --- Patch service to log to serial console for diagnostics ---
mkdir -p "$DIR/mnt"
mount -o loop "$DIR/rootfs.ext4" "$DIR/mnt"

echo "agent binary: $(ls -la "$DIR/mnt/usr/local/bin/sandchest-guest-agent" 2>/dev/null | awk '{print $5, $6, $7, $8}' || echo MISSING)"
echo "overlay-init: $(ls -la "$DIR/mnt/sbin/overlay-init" 2>/dev/null | awk '{print $5, $6, $7, $8}' || echo MISSING)"

cat > "$DIR/mnt/etc/systemd/system/sandchest-guest-agent.service" << 'SVC'
[Unit]
Description=Sandchest Guest Agent
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/bin/sandchest-guest-agent
Restart=on-failure
RestartSec=1
PrivateTmp=no
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyS0
Environment=RUST_LOG=info
[Install]
WantedBy=multi-user.target
SVC

umount "$DIR/mnt"
rmdir "$DIR/mnt"

# --- Write Firecracker config ---
python3 -c "
import json, sys
d = sys.argv[1]
c = {
  'boot-source': {
    'kernel_image_path': d + '/vmlinux',
    'boot_args': 'console=ttyS0 reboot=k panic=1 pci=off init=/sbin/overlay-init'
  },
  'drives': [{
    'drive_id': 'rootfs',
    'path_on_host': d + '/rootfs.ext4',
    'is_root_device': True,
    'is_read_only': False
  }],
  'machine-config': {'vcpu_count': 1, 'mem_size_mib': 256},
  'vsock': {'guest_cid': 3, 'uds_path': d + '/vsock.sock'}
}
json.dump(c, open(d + '/config.json', 'w'))
" "$DIR"

# --- Boot VM and capture console ---
echo ""
echo "=== BOOTING VM (15s) ==="
timeout 15 firecracker --api-sock "$DIR/api.sock" --config-file "$DIR/config.json" > "$DIR/console.log" 2>&1 || true

# --- Extract key output ---
echo ""
echo "=== KERNEL VERSION ==="
grep "Linux version" "$DIR/console.log" | head -1 || echo "(not found)"

echo ""
echo "=== SYSTEMD BOOT ==="
grep -E "systemd\\\\[1\\\\].*Detected|Hostname set" "$DIR/console.log" | head -2 || echo "(systemd did not start)"

echo ""
echo "=== GUEST AGENT STATUS ==="
grep -i "sandchest.*agent\\|guest.agent\\|agent ready\\|FAILED.*Agent" "$DIR/console.log" | grep -v "kernel\\|BIOS" | head -10 || echo "(no agent output)"

echo ""
echo "=== VSOCK FILES ==="
ls -la "$DIR"/vsock.sock* 2>/dev/null || echo "no vsock socket files created"

echo ""
echo "=== ERRORS ==="
grep -iE "panic|error|FAILED|cannot|denied" "$DIR/console.log" | grep -v "kernel\\|BIOS\\|i8042\\|DMA\\|SELinux\\|autofs4\\|cgroup\\|pci=off\\|memory_recursiveprot" | head -10 || echo "(none)"

echo ""
echo "=== FULL BOOT LOG (last 30 lines) ==="
tail -30 "$DIR/console.log"

rm -rf "$DIR"
`

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
      { error: 'Server must be fully provisioned before running diagnostics' },
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
    const scriptB64 = Buffer.from(DIAGNOSE_SCRIPT).toString('base64')
    const result = await execCommand(
      conn,
      `echo '${scriptB64}' | base64 -d > /tmp/_diag.sh && chmod +x /tmp/_diag.sh && /tmp/_diag.sh; rm -f /tmp/_diag.sh`,
      60_000,
    )

    return NextResponse.json({
      exitCode: result.code,
      output: (result.stdout + '\n' + result.stderr).trim(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Diagnostic error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  } finally {
    conn.end()
  }
}
