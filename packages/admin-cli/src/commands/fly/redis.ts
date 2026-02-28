import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { exec, commandExists } from '../../shell.js'
import { success, step, error, info, handleError } from '../../output.js'

export function flyRedisCommand(): Command {
  return new Command('redis')
    .description('Provision Upstash Redis on Fly.io')
    .option('--name <name>', 'Redis instance name', 'sandchest-redis')
    .action(async (opts: { name: string }) => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        requireConfig(config, 'fly.appName', 'fly.region')

        const region = config.fly!.region!
        const org = config.fly!.org ?? 'personal'

        step('[1/1]', `Creating Upstash Redis '${opts.name}' in ${region}...`)
        const result = await exec('flyctl', [
          'redis', 'create',
          '--name', opts.name,
          '--region', region,
          '--no-replicas',
          '--disable-eviction',
          '-o', org,
        ])
        if (result.code !== 0) {
          const output = result.stderr.trim() || result.stdout.trim()
          if (output.includes('already exists')) {
            info(`Redis '${opts.name}' already exists`)
          } else {
            error(output)
            process.exit(1)
          }
        } else {
          if (result.stdout) console.log(result.stdout.trim())
        }

        success(`Redis '${opts.name}' provisioned`)
      } catch (err) {
        handleError(err)
      }
    })
}
