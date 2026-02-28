import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { execInherit, commandExists } from '../../shell.js'
import { success, step, error, handleError } from '../../output.js'

export function flyDeployCommand(): Command {
  return new Command('deploy')
    .description('Deploy API to Fly.io (flyctl deploy --remote-only)')
    .action(async () => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        requireConfig(config, 'fly.appName')
        const appName = config.fly!.appName!

        step('[1/1]', `Deploying ${appName} via flyctl...`)
        const code = await execInherit('flyctl', ['deploy', '--remote-only', '-a', appName])
        if (code !== 0) {
          error(`flyctl deploy exited with code ${code}`)
          process.exit(code)
        }

        success(`Deployed ${appName}`)
      } catch (err) {
        handleError(err)
      }
    })
}
