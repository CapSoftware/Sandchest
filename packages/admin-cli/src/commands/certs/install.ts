import { Command } from 'commander'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommand, scpFile, sshConfigFromAdmin } from '../../ssh.js'
import { success, step, error, handleError } from '../../output.js'

const CERT_FILES = ['ca.pem', 'server.pem', 'server.key'] as const

export function certsInstallCommand(): Command {
  return new Command('install')
    .description('SCP server certificates to Hetzner node')
    .action(async () => {
      try {
        const config = readConfig()
        requireConfig(config, 'certs.dir', 'hetzner.host', 'hetzner.sshKeyPath')

        const certsDir = config.certs!.dir!
        for (const file of CERT_FILES) {
          const path = join(certsDir, file)
          if (!existsSync(path)) {
            error(`Certificate file not found: ${path}`)
            process.exit(1)
          }
        }

        step('[1/3]', 'Connecting to server via SSH...')
        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          step('[2/3]', 'Creating /etc/sandchest/certs directory...')
          const mkdirResult = await execCommand(conn, 'mkdir -p /etc/sandchest/certs && chmod 700 /etc/sandchest/certs')
          if (mkdirResult.code !== 0) {
            error(`Failed to create certs directory: ${mkdirResult.stderr}`)
            process.exit(1)
          }

          step('[3/3]', 'Uploading certificate files...')
          for (const file of CERT_FILES) {
            const localPath = join(certsDir, file)
            const remotePath = `/etc/sandchest/certs/${file}`
            await scpFile(conn, localPath, remotePath)
            // Set restrictive permissions
            await execCommand(conn, `chmod 600 ${remotePath}`)
          }

          success(`Installed ${CERT_FILES.length} certificate files to /etc/sandchest/certs/`)
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
