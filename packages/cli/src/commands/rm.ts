import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { getClient } from '../config.js'
import { success, printJson, handleError } from '../output.js'

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${message} (y/N) `)
    return answer.toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

export function rmCommand(): Command {
  return new Command('rm')
    .description('Destroy a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(
      async (sandboxId: string, options: { force?: boolean; json?: boolean }) => {
        try {
          if (!options.force) {
            const confirmed = await confirm(`Destroy sandbox ${sandboxId}?`)
            if (!confirmed) {
              console.log('Aborted.')
              return
            }
          }

          const client = getClient()
          const sandbox = await client.get(sandboxId)
          await sandbox.destroy()

          if (options.json) {
            printJson({ sandbox_id: sandboxId, status: 'deleted' })
          } else {
            success(`Sandbox ${sandboxId} destroyed`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
