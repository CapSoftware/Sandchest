import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommand, scpFile, execCommandStreaming, sshConfigFromAdmin } from '../../ssh.js'
import { presignDaemonBinary } from '../../r2.js'
import { exec } from '../../shell.js'
import { success, step, error, info, handleError } from '../../output.js'

export function nodeDeployCommand(): Command {
  return new Command('deploy')
    .description('Build, upload, and deploy the node daemon binary')
    .option('--skip-build', 'Skip cargo build (use existing binary)')
    .option('--version <ver>', 'R2 binary version tag', 'latest')
    .option('--local <path>', 'Deploy a local binary instead of R2')
    .action(async (opts: { skipBuild?: boolean; version: string; local?: string }) => {
      try {
        const config = readConfig()
        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          if (opts.local) {
            step('[1/3]', `Uploading local binary ${opts.local}...`)
            await scpFile(conn, opts.local, '/usr/local/bin/sandchest-node')
          } else {
            if (!opts.skipBuild) {
              step('[1/3]', 'Building sandchest-node (cargo build --release)...')
              const buildResult = await exec('cargo', ['build', '--release', '-p', 'sandchest-node'], {
                cwd: process.cwd(),
              })
              if (buildResult.code !== 0) {
                error(`Cargo build failed:\n${buildResult.stderr}`)
                process.exit(1)
              }
              info('Build successful')
            } else {
              step('[1/3]', 'Skipping build...')
            }

            step('[2/3]', `Downloading binary from R2 (${opts.version})...`)
            const url = await presignDaemonBinary(config, opts.version)
            const dlResult = await execCommand(conn, `curl -fsSL '${url}' -o /usr/local/bin/sandchest-node && chmod +x /usr/local/bin/sandchest-node`)
            if (dlResult.code !== 0) {
              error(`Failed to download binary: ${dlResult.stderr}`)
              process.exit(1)
            }
          }

          step('[3/3]', 'Restarting sandchest-node service...')
          const restartCode = await execCommandStreaming(
            conn,
            'systemctl restart sandchest-node && sleep 2 && systemctl status sandchest-node --no-pager',
            (data) => process.stdout.write(data),
            (data) => process.stderr.write(data),
          )

          if (restartCode !== 0) {
            error('Service restart may have failed — check logs')
            process.exit(1)
          }

          success('Node daemon deployed and restarted')
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
