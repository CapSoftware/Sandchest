import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { getClient } from '../config.js'
import { success, info, error, handleError } from '../output.js'

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

export function sshCommand(): Command {
  return new Command('ssh')
    .description('Open an interactive session in a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .option('--shell <shell>', 'Shell to use', '/bin/bash')
    .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable)', collectEnv, [])
    .action(
      async (
        sandboxId: string,
        options: { shell: string; env: string[] },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const env = options.env.length > 0 ? parseEnvPairs(options.env) : undefined

          const session = await sandbox.session.create({
            shell: options.shell,
            env,
          })

          success(`Session ${session.id} started (${options.shell})`)
          info('Type "exit" or press Ctrl+D to end the session.')

          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '$ ',
          })

          rl.prompt()

          for await (const line of rl) {
            if (line.trim() === 'exit') break

            try {
              const result = await session.exec(line)
              if (result.stdout) process.stdout.write(result.stdout)
              if (result.stderr) process.stderr.write(result.stderr)
            } catch (err) {
              error(err instanceof Error ? err.message : String(err))
            }

            rl.prompt()
          }

          await session.destroy()
          success('Session ended')
        } catch (err) {
          handleError(err)
        }
      },
    )
}
