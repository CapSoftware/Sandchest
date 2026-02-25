import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'

// Single SSH command that collects all metrics via procfs.
// Two /proc/stat samples 1s apart give real CPU usage.
const METRICS_SCRIPT = `
cpu1=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)
sleep 1
cpu2=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)
echo "CPU $cpu1 $cpu2"
awk '/MemTotal:|MemAvailable:/{printf "%s %s\\n", $1, $2}' /proc/meminfo
df -B1 / | awk 'NR==2{printf "DISK %s %s\\n", $3, $2}'
awk 'NR>2{rx+=$2; tx+=$10} END{printf "NET %d %d\\n", rx, tx}' /proc/net/dev
awk '{printf "LOAD %s %s %s\\n", $1, $2, $3}' /proc/loadavg
printf "DAEMON %s\\n" "$(systemctl is-active sandchest-node 2>/dev/null || echo unknown)"
`.trim()

interface MetricsResult {
  metrics: {
    cpu_percent: number
    memory_used_bytes: number
    memory_total_bytes: number
    disk_used_bytes: number
    disk_total_bytes: number
    network_rx_bytes: number
    network_tx_bytes: number
    load_avg_1: number
    load_avg_5: number
    load_avg_15: number
  } | null
  daemon_status: string
  collected_at: string
}

function parseMetrics(stdout: string): MetricsResult {
  const lines = stdout.trim().split('\n')
  let cpuPercent = 0
  let memTotal = 0
  let memAvailable = 0
  let diskUsed = 0
  let diskTotal = 0
  let netRx = 0
  let netTx = 0
  let load1 = 0
  let load5 = 0
  let load15 = 0
  let daemonStatus = 'unknown'

  for (const line of lines) {
    if (line.startsWith('CPU ')) {
      // CPU total1 idle1 total2 idle2
      const parts = line.slice(4).split(/\s+/).map(Number)
      if (parts.length >= 4) {
        const totalDelta = parts[2] - parts[0]
        const idleDelta = parts[3] - parts[1]
        cpuPercent = totalDelta > 0
          ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100)
          : 0
      }
    } else if (line.startsWith('MemTotal:')) {
      memTotal = parseInt(line.split(/\s+/)[1], 10) * 1024 // kB to bytes
    } else if (line.startsWith('MemAvailable:')) {
      memAvailable = parseInt(line.split(/\s+/)[1], 10) * 1024
    } else if (line.startsWith('DISK ')) {
      const parts = line.slice(5).split(/\s+/).map(Number)
      if (parts.length >= 2) {
        diskUsed = parts[0]
        diskTotal = parts[1]
      }
    } else if (line.startsWith('NET ')) {
      const parts = line.slice(4).split(/\s+/).map(Number)
      if (parts.length >= 2) {
        netRx = parts[0]
        netTx = parts[1]
      }
    } else if (line.startsWith('LOAD ')) {
      const parts = line.slice(5).split(/\s+/).map(Number)
      if (parts.length >= 3) {
        load1 = parts[0]
        load5 = parts[1]
        load15 = parts[2]
      }
    } else if (line.startsWith('DAEMON ')) {
      daemonStatus = line.slice(7).trim()
    }
  }

  return {
    metrics: {
      cpu_percent: cpuPercent,
      memory_used_bytes: memTotal - memAvailable,
      memory_total_bytes: memTotal,
      disk_used_bytes: diskUsed,
      disk_total_bytes: diskTotal,
      network_rx_bytes: netRx,
      network_tx_bytes: netTx,
      load_avg_1: load1,
      load_avg_5: load5,
      load_avg_15: load15,
    },
    daemon_status: daemonStatus,
    collected_at: new Date().toISOString(),
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const db = getDb()

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  if (server.provisionStatus !== 'completed') {
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
  }

  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
  }

  let conn
  try {
    conn = await createSshConnection({
      host: server.ip,
      port: server.sshPort,
      username: server.sshUser,
      privateKey: sshKey,
      readyTimeout: 5_000,
    })
  } catch {
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unreachable',
      collected_at: new Date().toISOString(),
    })
  }

  try {
    const result = await execCommand(conn, METRICS_SCRIPT)
    conn.end()

    if (result.code !== 0) {
      return NextResponse.json({
        metrics: null,
        daemon_status: 'unknown',
        collected_at: new Date().toISOString(),
      })
    }

    return NextResponse.json(parseMetrics(result.stdout))
  } catch {
    conn.end()
    return NextResponse.json({
      metrics: null,
      daemon_status: 'unknown',
      collected_at: new Date().toISOString(),
    })
  }
}
