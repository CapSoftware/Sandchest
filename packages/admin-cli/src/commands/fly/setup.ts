import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { exec, commandExists } from '../../shell.js'
import { success, step, error, info, handleError } from '../../output.js'

export function flySetupCommand(): Command {
  return new Command('setup')
    .description('Create Fly.io app and configure domain certificate')
    .option('--domain <domain>', 'Custom domain for the API', 'api.sandchest.com')
    .action(async (opts: { domain: string }) => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        requireConfig(config, 'fly.appName', 'fly.region')

        const appName = config.fly!.appName!
        const region = config.fly!.region!
        const org = config.fly!.org ?? 'personal'

        step('[1/3]', `Creating Fly app '${appName}' in ${region}...`)
        let result = await exec('flyctl', ['apps', 'create', appName, '--org', org])
        if (result.code !== 0) {
          if (result.stderr.includes('already exists')) {
            info(`App '${appName}' already exists, continuing...`)
          } else {
            error(result.stderr.trim())
            process.exit(1)
          }
        }

        step('[2/3]', `Setting primary region to ${region}...`)
        result = await exec('flyctl', ['regions', 'set', region, '-a', appName])
        if (result.code !== 0) {
          error(result.stderr.trim())
          process.exit(1)
        }

        step('[3/3]', `Adding certificate for ${opts.domain}...`)
        result = await exec('flyctl', ['certs', 'add', opts.domain, '-a', appName])
        if (result.code !== 0) {
          if (result.stderr.includes('already exists') || result.stdout.includes('already exists')) {
            info(`Certificate for ${opts.domain} already exists, continuing...`)
          } else {
            error(result.stderr.trim())
            process.exit(1)
          }
        }

        success(`Fly app '${appName}' configured with cert for ${opts.domain}`)
      } catch (err) {
        handleError(err)
      }
    })
}
