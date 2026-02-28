import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommand, sshConfigFromAdmin } from '../../ssh.js'
import { success, step, error, info, handleError } from '../../output.js'

export function nodeEnvCommand(): Command {
  return new Command('env')
    .description('Generate and push /etc/sandchest/node.env to the server')
    .option('--dry-run', 'Print env file contents without pushing')
    .action(async (opts: { dryRun?: boolean }) => {
      try {
        const config = readConfig()

        const nodeId = config.node?.id ?? 'node-hel1-01'
        const grpcPort = config.node?.grpcPort ?? 50051
        const apiBaseUrl = config.api?.baseUrl ?? 'https://api.sandchest.com'

        const envLines = [
          `NODE_ID=${nodeId}`,
          `GRPC_PORT=${grpcPort}`,
          `API_BASE_URL=${apiBaseUrl}`,
          `DATA_DIR=/var/sandchest`,
          `RUST_LOG=info`,
          `TLS_CERT=/etc/sandchest/certs/server.pem`,
          `TLS_KEY=/etc/sandchest/certs/server.key`,
          `TLS_CA=/etc/sandchest/certs/ca.pem`,
        ]

        // Add R2 credentials if configured (for artifact uploads)
        if (config.r2?.endpoint) envLines.push(`R2_ENDPOINT=${config.r2.endpoint}`)
        if (config.r2?.accessKeyId) envLines.push(`R2_ACCESS_KEY_ID=${config.r2.accessKeyId}`)
        if (config.r2?.secretAccessKey) envLines.push(`R2_SECRET_ACCESS_KEY=${config.r2.secretAccessKey}`)
        if (config.r2?.bucket) envLines.push(`R2_BUCKET=${config.r2.bucket}`)

        const envContent = envLines.join('\n') + '\n'

        if (opts.dryRun) {
          console.log(envContent)
          return
        }

        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        step('[1/2]', `Connecting to ${config.hetzner!.host}...`)
        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          step('[2/2]', 'Writing /etc/sandchest/node.env...')
          const escaped = envContent.replace(/'/g, "'\\''")
          const result = await execCommand(
            conn,
            `mkdir -p /etc/sandchest && printf '%s' '${escaped}' > /etc/sandchest/node.env && chmod 600 /etc/sandchest/node.env`,
          )

          if (result.code !== 0) {
            error(`Failed to write env file: ${result.stderr}`)
            process.exit(1)
          }

          success('Wrote /etc/sandchest/node.env')
          info(`${envLines.length} variables set`)
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
