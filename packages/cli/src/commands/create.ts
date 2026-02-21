import { Command, Option } from 'commander'
import { getClient } from '../config.js'
import { success, info, printJson, handleError } from '../output.js'

function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx === -1) {
      throw new Error(`Invalid env format: "${pair}". Use KEY=VALUE.`)
    }
    env[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return env
}

export function createCommand(): Command {
  return new Command('create')
    .description('Create a new sandbox')
    .option('-i, --image <image>', 'Base image')
    .addOption(
      new Option('-p, --profile <profile>', 'Resource profile').choices([
        'small',
        'medium',
        'large',
      ]),
    )
    .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable)', collectEnv, [])
    .option('--ttl <seconds>', 'Time-to-live in seconds', parseInt)
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        image?: string
        profile?: string
        env: string[]
        ttl?: number
        json?: boolean
      }) => {
        try {
          const client = getClient()
          const env = options.env.length > 0 ? parseEnvPairs(options.env) : undefined

          const sandbox = await client.create({
            image: options.image,
            profile: options.profile as 'small' | 'medium' | 'large' | undefined,
            env,
            ttlSeconds: options.ttl,
          })

          if (options.json) {
            printJson({
              sandbox_id: sandbox.id,
              status: sandbox.status,
              replay_url: sandbox.replayUrl,
            })
          } else {
            success(`Sandbox ${sandbox.id} created`)
            info(`Status:  ${sandbox.status}`)
            info(`Replay:  ${sandbox.replayUrl}`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
