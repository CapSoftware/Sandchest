import { Command } from 'commander'
import { readConfig } from '../../config.js'
import { execInherit, commandExists } from '../../shell.js'
import { error, handleError } from '../../output.js'

export function flyRedisStatusCommand(): Command {
  return new Command('redis-status')
    .description('Show Upstash Redis status')
    .option('--name <name>', 'Redis instance name', 'sandchest-redis')
    .action(async (opts: { name: string }) => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        const org = config.fly?.org ?? 'personal'

        const code = await execInherit('flyctl', ['redis', 'status', opts.name, '-o', org])
        if (code !== 0) process.exit(code)
      } catch (err) {
        handleError(err)
      }
    })
}
