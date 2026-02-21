import { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { getClient } from '../config.js'
import { success, printJson, handleError } from '../output.js'

export function downloadCommand(): Command {
  return new Command('download')
    .description('Download a file from a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<remote_path>', 'File path in the sandbox')
    .argument('[local_path]', 'Local destination (defaults to filename from remote path)')
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        remotePath: string,
        localPath: string | undefined,
        options: { json?: boolean },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const content = await sandbox.fs.download(remotePath)

          const dest = localPath ?? basename(remotePath)
          writeFileSync(dest, content)

          if (options.json) {
            printJson({
              sandbox_id: sandboxId,
              remote_path: remotePath,
              local_path: dest,
              bytes: content.byteLength,
            })
          } else {
            success(`Downloaded ${remotePath} → ${dest} (${content.byteLength} bytes)`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
