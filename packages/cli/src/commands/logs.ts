import { Command } from 'commander'
import chalk from 'chalk'
import type { ListExecsResponse, ExecStatus } from '@sandchest/contract'
import { getClient } from '../config.js'
import { printJson, formatAge, handleError } from '../output.js'

const COL_WIDTHS = [16, 10, 8, 10, 8] as const

function execStatusColor(status: string): string {
  switch (status) {
    case 'done':
      return chalk.green(status)
    case 'running':
    case 'queued':
      return chalk.yellow(status)
    case 'failed':
    case 'timed_out':
      return chalk.red(status)
    default:
      return status
  }
}

function formatCmd(cmd: string | string[]): string {
  return Array.isArray(cmd) ? cmd.join(' ') : cmd
}

export function logsCommand(): Command {
  return new Command('logs')
    .description('List executions for a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .option('-s, --status <status>', 'Filter by exec status')
    .option('-n, --limit <count>', 'Max number of results', parseInt)
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        options: { status?: ExecStatus; limit?: number; json?: boolean },
      ) => {
        try {
          const client = getClient()
          const res = await client._http.request<ListExecsResponse>({
            method: 'GET',
            path: `/v1/sandboxes/${sandboxId}/execs`,
            query: {
              status: options.status,
              limit: options.limit,
            },
          })

          if (options.json) {
            printJson(res.execs)
            return
          }

          if (res.execs.length === 0) {
            console.log('No executions found.')
            return
          }

          const headers = ['EXEC ID', 'STATUS', 'EXIT', 'DURATION', 'AGE', 'COMMAND']
          console.log(
            headers
              .map((h, i) => (i < COL_WIDTHS.length ? h.padEnd(COL_WIDTHS[i]!) : h))
              .join('  '),
          )
          console.log(
            [...COL_WIDTHS, 30].map((w) => '\u2500'.repeat(w)).join('  '),
          )

          for (const exec of res.execs) {
            const exit = exec.exit_code !== null ? String(exec.exit_code) : '-'
            const duration = exec.duration_ms !== null ? `${exec.duration_ms}ms` : '-'
            console.log(
              [
                exec.exec_id.padEnd(COL_WIDTHS[0]),
                execStatusColor(exec.status.padEnd(COL_WIDTHS[1])),
                exit.padEnd(COL_WIDTHS[2]),
                duration.padEnd(COL_WIDTHS[3]),
                formatAge(exec.created_at).padEnd(COL_WIDTHS[4]),
                formatCmd(exec.cmd),
              ].join('  '),
            )
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
