import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { execInherit } from '../../shell.js'
import { error, handleError } from '../../output.js'

export function nodeSshCommand(): Command {
  return new Command('ssh')
    .description('SSH into Hetzner node or run a remote command')
    .argument('[cmd...]', 'Command to run remotely')
    .action(async (cmd: string[]) => {
      try {
        const config = readConfig()
        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        const host = config.hetzner!.host!
        const keyPath = config.hetzner!.sshKeyPath!
        const user = config.hetzner!.sshUser ?? 'root'
        const port = String(config.hetzner!.sshPort ?? 22)

        const sshArgs = [
          '-i', keyPath,
          '-p', port,
          '-o', 'StrictHostKeyChecking=accept-new',
          `${user}@${host}`,
        ]

        if (cmd.length > 0) {
          sshArgs.push('--', ...cmd)
        }

        const code = await execInherit('ssh', sshArgs)
        if (code !== 0) {
          error(`SSH exited with code ${code}`)
          process.exit(code)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
