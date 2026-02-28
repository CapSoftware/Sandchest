import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { execInherit, commandExists } from '../../shell.js'
import { error, handleError } from '../../output.js'

export function flyStatusCommand(): Command {
  return new Command('status')
    .description('Show Fly.io app status')
    .action(async () => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        requireConfig(config, 'fly.appName')
        const appName = config.fly!.appName!

        const code = await execInherit('flyctl', ['status', '-a', appName])
        if (code !== 0) process.exit(code)
      } catch (err) {
        handleError(err)
      }
    })
}
