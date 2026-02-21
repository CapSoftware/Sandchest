import { Command } from 'commander'
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

export function forkCommand(): Command {
  return new Command('fork')
    .description('Fork a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID to fork')
    .option('-e, --env <KEY=VALUE>', 'Environment variable override (repeatable)', collectEnv, [])
    .option('--ttl <seconds>', 'Time-to-live in seconds', parseInt)
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        options: { env: string[]; ttl?: number; json?: boolean },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const env = options.env.length > 0 ? parseEnvPairs(options.env) : undefined

          const forked = await sandbox.fork({
            env,
            ttlSeconds: options.ttl,
          })

          if (options.json) {
            printJson({
              sandbox_id: forked.id,
              status: forked.status,
              forked_from: sandboxId,
              replay_url: forked.replayUrl,
            })
          } else {
            success(`Forked ${sandboxId} → ${forked.id}`)
            info(`Status:  ${forked.status}`)
            info(`Replay:  ${forked.replayUrl}`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
