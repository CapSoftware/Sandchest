import { Command } from 'commander'
import { exec as execCb } from 'node:child_process'
import { getClient } from '../config.js'
import { printJson, handleError } from '../output.js'

function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open'
  execCb(`${cmd} ${url}`)
}

export function replayCommand(): Command {
  return new Command('replay')
    .description('Show the replay URL for a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .option('--open', 'Open the replay URL in a browser')
    .option('--json', 'Output as JSON')
    .action(async (sandboxId: string, options: { open?: boolean; json?: boolean }) => {
      try {
        const client = getClient()
        const sandbox = await client.get(sandboxId)

        if (options.json) {
          printJson({
            sandbox_id: sandbox.id,
            replay_url: sandbox.replayUrl,
          })
        } else {
          console.log(sandbox.replayUrl)
        }

        if (options.open) {
          openUrl(sandbox.replayUrl)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
