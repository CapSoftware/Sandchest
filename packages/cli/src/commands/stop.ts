import { Command } from 'commander'
import { getClient } from '../config.js'
import { success, printJson, handleError } from '../output.js'

export function stopCommand(): Command {
  return new Command('stop')
    .description('Stop a running sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .option('--json', 'Output as JSON')
    .action(async (sandboxId: string, options: { json?: boolean }) => {
      try {
        const client = getClient()
        const sandbox = await client.get(sandboxId)
        await sandbox.stop()

        if (options.json) {
          printJson({ sandbox_id: sandbox.id, status: sandbox.status })
        } else {
          success(`Sandbox ${sandboxId} stopped`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
