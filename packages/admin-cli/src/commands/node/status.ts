import { Command } from 'commander'
import chalk from 'chalk'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommand, sshConfigFromAdmin } from '../../ssh.js'
import { success, step, error, handleError } from '../../output.js'

const STATUS_SCRIPT = `
echo "DAEMON $(systemctl is-active sandchest-node 2>/dev/null || echo unknown)"
echo "VERSION $(/usr/local/bin/sandchest-node --version 2>/dev/null || echo unknown)"
echo "KVM $(test -w /dev/kvm && echo yes || echo no)"
echo "UPTIME $(uptime -s 2>/dev/null || echo unknown)"
df -h /var/sandchest 2>/dev/null | awk 'NR==2{printf "DISK %s used of %s (%s)\\n", $3, $2, $5}'
ls /var/sandchest/images/ 2>/dev/null | wc -l | xargs printf "IMAGES %s\\n"
`.trim()

export function nodeStatusCommand(): Command {
  return new Command('status')
    .description('Quick health check on the Hetzner node')
    .action(async () => {
      try {
        const config = readConfig()
        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        step('[1/2]', `Connecting to ${config.hetzner!.host}...`)
        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          step('[2/2]', 'Checking node status...')
          const result = await execCommand(conn, STATUS_SCRIPT)
          if (result.code !== 0) {
            error(`Status check failed: ${result.stderr}`)
            process.exit(1)
          }

          console.log()
          for (const line of result.stdout.trim().split('\n')) {
            if (line.startsWith('DAEMON ')) {
              const status = line.slice(7).trim()
              const colored = status === 'active' ? chalk.green(status) : chalk.red(status)
              console.log(`  Daemon:   ${colored}`)
            } else if (line.startsWith('VERSION ')) {
              console.log(`  Version:  ${line.slice(8).trim()}`)
            } else if (line.startsWith('KVM ')) {
              const kvm = line.slice(4).trim()
              console.log(`  KVM:      ${kvm === 'yes' ? chalk.green('available') : chalk.red('not available')}`)
            } else if (line.startsWith('UPTIME ')) {
              console.log(`  Up since: ${line.slice(7).trim()}`)
            } else if (line.startsWith('DISK ')) {
              console.log(`  Disk:     ${line.slice(5).trim()}`)
            } else if (line.startsWith('IMAGES ')) {
              console.log(`  Images:   ${line.slice(7).trim()} files`)
            }
          }
          console.log()

          success('Node status retrieved')
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
