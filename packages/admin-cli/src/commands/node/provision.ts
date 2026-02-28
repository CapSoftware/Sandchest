import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { createSshConnection, execCommandStreaming, sshConfigFromAdmin } from '../../ssh.js'
import { PROVISION_STEPS, resolveCommands } from '../../provisioner.js'
import { success, step, error, warn, info, handleError } from '../../output.js'

export function nodeProvisionCommand(): Command {
  return new Command('provision')
    .description('Run provisioner steps on Hetzner node via SSH')
    .option('--step <id>', 'Run only a specific step')
    .option('--from <id>', 'Resume from a specific step')
    .option('--dry-run', 'Print commands without executing')
    .action(async (opts: { step?: string; from?: string; dryRun?: boolean }) => {
      try {
        const config = readConfig()
        requireConfig(config, 'hetzner.host', 'hetzner.sshKeyPath')

        let steps = PROVISION_STEPS
        if (opts.step) {
          const found = steps.find((s) => s.id === opts.step)
          if (!found) {
            error(`Unknown step: ${opts.step}`)
            info(`Available steps: ${steps.map((s) => s.id).join(', ')}`)
            process.exit(1)
          }
          steps = [found]
        } else if (opts.from) {
          const idx = steps.findIndex((s) => s.id === opts.from)
          if (idx === -1) {
            error(`Unknown step: ${opts.from}`)
            info(`Available steps: ${steps.map((s) => s.id).join(', ')}`)
            process.exit(1)
          }
          steps = steps.slice(idx)
        }

        if (opts.dryRun) {
          for (const s of steps) {
            const cmds = await resolveCommands(s, config)
            console.log(`\n# ${s.id}: ${s.name}`)
            for (const cmd of cmds) console.log(cmd)
          }
          return
        }

        step('[connect]', `Connecting to ${config.hetzner!.host}...`)
        const conn = await createSshConnection(sshConfigFromAdmin(config))

        try {
          let completed = 0
          for (const s of steps) {
            step(`[${s.id}]`, s.name)
            const cmds = await resolveCommands(s, config)
            const fullCmd = cmds.join(' && ')

            const code = await execCommandStreaming(
              conn,
              fullCmd,
              (data) => process.stdout.write(data),
              (data) => process.stderr.write(data),
            )

            if (code !== 0) {
              error(`Step '${s.id}' failed with exit code ${code}`)
              if (completed < steps.length - 1) {
                warn(`Resume with: sandchest-admin node provision --from ${s.id}`)
              }
              process.exit(1)
            }

            // Run validation if present
            if (s.validate) {
              const valCode = await execCommandStreaming(
                conn,
                s.validate,
                (data) => process.stdout.write(data),
                (data) => process.stderr.write(data),
              )
              if (valCode !== 0) {
                warn(`Validation for '${s.id}' returned non-zero (${valCode})`)
              }
            }

            completed++
          }

          success(`All ${completed} provision steps completed`)
        } finally {
          conn.end()
        }
      } catch (err) {
        handleError(err)
      }
    })
}
