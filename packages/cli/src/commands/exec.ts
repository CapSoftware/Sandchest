import { Command } from 'commander'
import { getClient } from '../config.js'
import { printJson, handleError } from '../output.js'

export function execCommand(): Command {
  return new Command('exec')
    .description('Execute a command in a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<cmd>', 'Command to execute (quote if it contains spaces)')
    .option('--no-stream', 'Wait for completion instead of streaming')
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        cmd: string,
        options: { stream: boolean; json?: boolean },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)

          if (options.json || !options.stream) {
            const result = await sandbox.exec(cmd)

            if (options.json) {
              printJson({
                exec_id: result.execId,
                exit_code: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                duration_ms: result.durationMs,
              })
            } else {
              if (result.stdout) process.stdout.write(result.stdout)
              if (result.stderr) process.stderr.write(result.stderr)
            }

            if (result.exitCode !== 0) process.exit(1)
          } else {
            const result = await sandbox.exec(cmd, {
              onStdout: (data) => process.stdout.write(data),
              onStderr: (data) => process.stderr.write(data),
            })

            if (result.exitCode !== 0) process.exit(1)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
