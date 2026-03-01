import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { flyctl, commandExists } from '../../shell.js'
import { success, step, error, warn, info, handleError } from '../../output.js'

export function flySetupCommand(): Command {
  return new Command('setup')
    .description('Create Fly.io app, configure domain certificate, and provision Redis')
    .option('--domain <domain>', 'Custom domain for the API', 'api.sandchest.com')
    .option('--redis-name <name>', 'Redis instance name', 'sandchest-redis')
    .option('--skip-redis', 'Skip Redis provisioning')
    .action(async (opts: { domain: string; redisName: string; skipRedis?: boolean }) => {
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
        const totalSteps = opts.skipRedis ? 3 : 4

        step(`[1/${totalSteps}]`, `Creating Fly app '${appName}' in ${region}...`)
        let result = await flyctl( ['apps', 'create', appName, '--org', org])
        if (result.code !== 0) {
          if (result.stderr.includes('already exists')) {
            info(`App '${appName}' already exists, continuing...`)
          } else {
            error(result.stderr.trim())
            process.exit(1)
          }
        }

        step(`[2/${totalSteps}]`, `Setting primary region to ${region}...`)
        result = await flyctl( ['regions', 'set', region, '-a', appName])
        if (result.code !== 0) {
          error(result.stderr.trim())
          process.exit(1)
        }

        step(`[3/${totalSteps}]`, `Adding certificate for ${opts.domain}...`)
        result = await flyctl( ['certs', 'add', opts.domain, '-a', appName])
        if (result.code !== 0) {
          if (result.stderr.includes('already exists') || result.stdout.includes('already exists')) {
            info(`Certificate for ${opts.domain} already exists, continuing...`)
          } else {
            error(result.stderr.trim())
            process.exit(1)
          }
        }

        if (!opts.skipRedis) {
          step(`[4/${totalSteps}]`, `Provisioning Upstash Redis '${opts.redisName}' in ${region}...`)
          result = await flyctl( [
            'redis', 'create',
            '--name', opts.redisName,
            '--region', region,
            '--no-replicas',
            '--disable-eviction',
            '-o', org,
          ])
          if (result.code !== 0) {
            const output = result.stderr.trim() || result.stdout.trim()
            if (output.includes('already exists')) {
              info(`Redis '${opts.redisName}' already exists, continuing...`)
            } else {
              error(output)
              info('If Redis is already provisioned, re-run with --skip-redis')
              process.exit(1)
            }
          } else {
            // Try to extract Redis URL from flyctl output and set it as a secret
            const redisUrlMatch = result.stdout.match(/rediss?:\/\/[^\s]+/)
            if (redisUrlMatch) {
              const redisUrl = redisUrlMatch[0]
              info(`Captured Redis URL, setting as Fly secret...`)
              const secretResult = await flyctl( [
                'secrets', 'set',
                `REDIS_URL=${redisUrl}`,
                'REDIS_FAMILY=6',
                '--stage',
                '-a', appName,
              ])
              if (secretResult.code === 0) {
                success('REDIS_URL and REDIS_FAMILY=6 staged as Fly secrets')
              } else {
                warn('Could not auto-set Redis secrets. Set them manually:')
                info(`  flyctl secrets set -a ${appName} REDIS_URL="${redisUrl}" REDIS_FAMILY=6`)
              }
            } else {
              warn('Could not parse Redis URL from output. Set it manually:')
              info(`  flyctl secrets set -a ${appName} REDIS_URL="<url>" REDIS_FAMILY=6`)
              if (result.stdout) console.log(result.stdout.trim())
            }
          }
        }

        success(`Fly app '${appName}' configured with cert for ${opts.domain}${opts.skipRedis ? '' : ` and Redis '${opts.redisName}'`}`)
      } catch (err) {
        handleError(err)
      }
    })
}
