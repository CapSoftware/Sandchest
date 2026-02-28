import { Command } from 'commander'
import chalk from 'chalk'
import { step, success, error, info, handleError } from '../output.js'

const SETUP_STEPS = [
  { name: 'init', desc: 'Interactive config setup', cmd: 'init' },
  { name: 'certs-generate', desc: 'Generate mTLS certificates', cmd: 'certs generate' },
  { name: 'fly-setup', desc: 'Create Fly.io app', cmd: 'fly setup' },
  { name: 'fly-redis', desc: 'Provision Redis', cmd: 'fly redis' },
  { name: 'certs-install', desc: 'Install certs on node', cmd: 'certs install' },
  { name: 'node-provision', desc: 'Provision Hetzner node', cmd: 'node provision' },
  { name: 'node-env', desc: 'Push node.env', cmd: 'node env' },
  { name: 'node-deploy', desc: 'Deploy node daemon', cmd: 'node deploy' },
  { name: 'fly-secrets', desc: 'Set Fly.io secrets', cmd: 'fly secrets' },
  { name: 'fly-deploy', desc: 'Deploy API to Fly.io', cmd: 'fly deploy' },
  { name: 'db-migrate', desc: 'Run database migrations', cmd: 'db migrate' },
  { name: 'db-seed', desc: 'Seed database', cmd: 'db seed' },
  { name: 'dns-show', desc: 'Show DNS records', cmd: 'dns show' },
  { name: 'verify', desc: 'Verify deployment', cmd: 'verify' },
] as const

export function setupCommand(): Command {
  return new Command('setup')
    .description('Run all deployment steps in sequence')
    .option('--from <step>', 'Resume from a specific step')
    .option('--list', 'List all steps without running')
    .action(async (opts: { from?: string; list?: boolean }) => {
      try {
        if (opts.list) {
          console.log('\nDeployment steps:')
          for (let i = 0; i < SETUP_STEPS.length; i++) {
            const s = SETUP_STEPS[i]
            console.log(`  ${chalk.dim(`${i + 1}.`)} ${chalk.bold(s.name)} — ${s.desc} (${chalk.dim(s.cmd)})`)
          }
          return
        }

        let startIdx = 0
        if (opts.from) {
          const idx = SETUP_STEPS.findIndex((s) => s.name === opts.from)
          if (idx === -1) {
            error(`Unknown step: ${opts.from}`)
            info(`Available steps: ${SETUP_STEPS.map((s) => s.name).join(', ')}`)
            process.exit(1)
          }
          startIdx = idx
        }

        const steps = SETUP_STEPS.slice(startIdx)
        console.log(`\nRunning ${steps.length} deployment steps...\n`)

        // Dynamically import and run each command through the program
        // Instead of re-importing everything, we spawn ourselves as child processes
        const { execInherit } = await import('../shell.js')

        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]
          step(`[${startIdx + i + 1}/${SETUP_STEPS.length}]`, `${s.desc} (${s.cmd})`)

          const args = s.cmd.split(' ')
          const code = await execInherit('sandchest-admin', args)
          if (code !== 0) {
            error(`Step '${s.name}' failed with exit code ${code}`)
            if (i < steps.length - 1) {
              const nextStep = steps[i + 1]
              info(`Resume with: sandchest-admin setup --from ${nextStep.name}`)
            }
            process.exit(1)
          }
        }

        console.log()
        success('All deployment steps completed')
      } catch (err) {
        handleError(err)
      }
    })
}
