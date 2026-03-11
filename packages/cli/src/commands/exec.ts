import { Command } from 'commander'
import { getClient } from '../config.js'
import { printJson, handleError } from '../output.js'

export function execCommand(): Command {
  return new Command('exec')
    .description('Execute a command in a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<cmd...>', 'Command to execute')
    .allowUnknownOption(true)
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        cmdParts: string[],
        options: { json?: boolean },
      ) => {
        const cmd = cmdParts.join(' ')
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
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
        } catch (err) {
          handleError(err)
        }
      },
    )
}
