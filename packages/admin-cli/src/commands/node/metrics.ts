import { Command } from 'commander'
import chalk from 'chalk'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommand, sshConfigFromAdmin } from '../../ssh.js'
import { METRICS_SCRIPT, parseMetrics } from '../../metrics.js'
import { header, step, error, handleError } from '../../output.js'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function colorPercent(pct: number): string {
  if (pct >= 90) return chalk.red(`${pct}%`)
  if (pct >= 70) return chalk.yellow(`${pct}%`)
  return chalk.green(`${pct}%`)
}

export function nodeMetricsCommand(): Command {
  return new Command('metrics')
    .description('Collect and display server metrics via SSH')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = readConfig()
        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        step('[1/2]', `Connecting to ${config.hetzner!.host}...`)
        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          step('[2/2]', 'Collecting metrics (1s sample)...')
          const result = await execCommand(conn, METRICS_SCRIPT)
          if (result.code !== 0) {
            error(`Metrics collection failed: ${result.stderr}`)
            process.exit(1)
          }

          const data = parseMetrics(result.stdout)

          if (opts.json) {
            console.log(JSON.stringify(data, null, 2))
            return
          }

          const m = data.metrics!
          const memPct = Math.round((m.memory_used_bytes / m.memory_total_bytes) * 100)
          const diskPct = Math.round((m.disk_used_bytes / m.disk_total_bytes) * 100)

          header('Server Metrics')
          console.log(`  CPU:     ${colorPercent(m.cpu_percent)}`)
          console.log(`  Memory:  ${formatBytes(m.memory_used_bytes)} / ${formatBytes(m.memory_total_bytes)} (${colorPercent(memPct)})`)
          console.log(`  Disk:    ${formatBytes(m.disk_used_bytes)} / ${formatBytes(m.disk_total_bytes)} (${colorPercent(diskPct)})`)
          console.log(`  Network: ${formatBytes(m.network_rx_bytes)} rx / ${formatBytes(m.network_tx_bytes)} tx`)
          console.log(`  Load:    ${m.load_avg_1} / ${m.load_avg_5} / ${m.load_avg_15}`)
          console.log(`  Daemon:  ${data.daemon_status === 'active' ? chalk.green(data.daemon_status) : chalk.red(data.daemon_status)}`)
          console.log(`  Time:    ${data.collected_at}`)
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
