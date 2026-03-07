import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { getClient } from '../config.js'
import { success, printJson, handleError } from '../output.js'

export function createUploadCommand(
  name = 'upload',
  description = 'Upload a local file to a sandbox',
): Command {
  return new Command(name)
    .description(description)
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<local_path>', 'Local file path')
    .argument('<remote_path>', 'Destination path in the sandbox')
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        localPath: string,
        remotePath: string,
        options: { json?: boolean },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const content = new Uint8Array(readFileSync(localPath))

          await sandbox.fs.upload(remotePath, content)

          if (options.json) {
            printJson({
              sandbox_id: sandboxId,
              local_path: localPath,
              remote_path: remotePath,
              bytes: content.byteLength,
            })
          } else {
            success(`Uploaded ${localPath} → ${remotePath} (${content.byteLength} bytes)`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}

export function uploadCommand(): Command {
  return createUploadCommand()
}
