import { createConnection } from 'node:net'
import { createPasswordSshConnection, execCommand } from './ssh.js'

const ROBOT_API = 'https://robot-ws.your-server.de'

function robotAuth(): { user: string; password: string } {
  const user = process.env.HETZNER_ROBOT_USER
  const password = process.env.HETZNER_ROBOT_PASSWORD
  if (!user || !password) {
    throw new Error('HETZNER_ROBOT_USER and HETZNER_ROBOT_PASSWORD must be set')
  }
  return { user, password }
}

function basicHeader(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
}

interface HetznerServer {
  server: {
    server_number: number
    server_ip: string
    server_name: string
  }
}

export async function getServerNumber(ip: string): Promise<number> {
  const { user, password } = robotAuth()
  const res = await fetch(`${ROBOT_API}/server`, {
    headers: { Authorization: basicHeader(user, password) },
  })
  if (!res.ok) {
    throw new Error(`Hetzner API /server failed: ${res.status} ${await res.text()}`)
  }
  const servers = (await res.json()) as HetznerServer[]
  const match = servers.find((s) => s.server.server_ip === ip)
  if (!match) {
    throw new Error(`No Hetzner server found with IP ${ip}`)
  }
  return match.server.server_number
}

interface RescueResponse {
  rescue: {
    server_number: number
    os: string
    active: boolean
    password: string
  }
}

export async function deactivateRescue(serverNumber: number): Promise<void> {
  const { user, password } = robotAuth()
  const res = await fetch(`${ROBOT_API}/boot/${serverNumber}/rescue`, {
    method: 'DELETE',
    headers: { Authorization: basicHeader(user, password) },
  })
  if (!res.ok) {
    throw new Error(`Hetzner API deactivate rescue failed: ${res.status} ${await res.text()}`)
  }
}

export async function activateRescue(serverNumber: number): Promise<string> {
  const { user, password } = robotAuth()
  const res = await fetch(`${ROBOT_API}/boot/${serverNumber}/rescue`, {
    method: 'POST',
    headers: {
      Authorization: basicHeader(user, password),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'os=linux',
  })
  if (!res.ok) {
    throw new Error(`Hetzner API activate rescue failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as RescueResponse
  return data.rescue.password
}

export async function hardwareReset(ip: string): Promise<void> {
  const { user, password } = robotAuth()
  const res = await fetch(`${ROBOT_API}/reset/${ip}`, {
    method: 'POST',
    headers: {
      Authorization: basicHeader(user, password),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'type=hw',
  })
  if (!res.ok) {
    throw new Error(`Hetzner API hardware reset failed: ${res.status} ${await res.text()}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForSsh(
  ip: string,
  password: string,
  opts?: { maxAttempts?: number | undefined; label?: string | undefined },
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 18
  const label = opts?.label ?? 'Server'
  const timeoutMin = Math.round((maxAttempts * 10) / 60)
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const conn = await createPasswordSshConnection({
        host: ip,
        port: 22,
        username: 'root',
        password,
      })
      conn.end()
      return
    } catch {
      await sleep(10_000)
    }
  }
  throw new Error(`${label} did not become reachable within ${timeoutMin} minutes`)
}

/**
 * Check if a TCP port is reachable (no auth, just SYN → ACK).
 */
function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: ip, port, timeout: timeoutMs })
    sock.on('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('timeout', () => {
      sock.destroy()
      resolve(false)
    })
    sock.on('error', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/**
 * Wait for SSH to become unreachable (confirms the server is actually rebooting).
 */
async function waitForSshDown(ip: string): Promise<void> {
  // Give the reboot command a moment to start shutting down
  await sleep(5_000)
  for (let i = 0; i < 30; i++) {
    const up = await tcpProbe(ip, 22, 3_000)
    if (!up) return
    await sleep(5_000)
  }
  // If it never went down, that's fine — maybe the reboot was very fast
}

/**
 * After installimage + reboot, wait for the fresh OS to come up and verify
 * we're no longer in rescue mode (i.e. Ubuntu is actually installed).
 */
export async function waitForFreshOs(ip: string, password: string): Promise<void> {
  // First, wait for SSH to go down so we don't accidentally connect to the
  // still-running rescue system before the reboot takes effect.
  await waitForSshDown(ip)

  // Now poll until we get Ubuntu (not rescue Debian). Bare metal reboot can
  // take a while — allow up to 5 minutes of retries.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const conn = await createPasswordSshConnection({
        host: ip,
        port: 22,
        username: 'root',
        password,
      })
      try {
        const result = await execCommand(conn, 'cat /etc/os-release')
        if (result.code === 0 && result.stdout.includes('Ubuntu')) {
          return // Fresh OS is up
        }
      } finally {
        conn.end()
      }
    } catch {
      // SSH not ready yet
    }
    await sleep(10_000)
  }

  throw new Error('Fresh OS did not come up within 5 minutes. Server may still be in rescue mode.')
}

const AUTOSETUP_CONFIG = `DRIVE1 /dev/nvme0n1
BOOTLOADER grub
HOSTNAME sandchest-node
PART /boot/efi esp 256M
PART /boot ext4 1G
PART / ext4 all
IMAGE /root/.oldroot/nfs/images/Ubuntu-2404-noble-amd64-base.tar.gz
`

export async function runInstallimage(ip: string, password: string): Promise<string> {
  const conn = await createPasswordSshConnection({
    host: ip,
    port: 22,
    username: 'root',
    password,
  })

  try {
    // Locate installimage
    const findResult = await execCommand(conn, 'command -v installimage 2>/dev/null || find / -name installimage -type f 2>/dev/null | head -1')
    const installBin = findResult.stdout.trim().split('\n')[0]
    if (!installBin) {
      throw new Error('installimage not found on rescue system. Is the server in rescue mode?')
    }

    // Write /autosetup — installimage detects this file and runs unattended
    const writeResult = await execCommand(
      conn,
      `cat > /autosetup << 'HEREDOC'\n${AUTOSETUP_CONFIG}HEREDOC`,
    )
    if (writeResult.code !== 0) {
      throw new Error(`Failed to write /autosetup: ${writeResult.stderr}`)
    }

    // Run installimage — pipe yes to auto-confirm any prompts
    const installResult = await execCommand(
      conn,
      `export TERM=xterm && yes | ${installBin}`,
    )
    if (installResult.code !== 0) {
      // Grab the debug log for detailed error info
      const debugLog = await execCommand(conn, 'cat /root/debug.txt 2>/dev/null | tail -50')
      const debugInfo = debugLog.stdout.trim()
      throw new Error(
        `installimage failed (exit ${installResult.code}): ${(installResult.stdout + '\n' + installResult.stderr).trim()}${debugInfo ? '\n\n--- debug.txt ---\n' + debugInfo : ''}`,
      )
    }

    return (installResult.stdout + '\n' + installResult.stderr).trim()
  } finally {
    conn.end()
  }
}
