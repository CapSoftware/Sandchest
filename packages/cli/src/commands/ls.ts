import { Command } from 'commander'
import type { ListSandboxesResponse, SandboxStatus } from '@sandchest/contract'
import { getClient } from '../config.js'
import { printJson, formatAge, statusColor, handleError } from '../output.js'

const COL_WIDTHS = [20, 14, 20, 10, 8] as const

export function lsCommand(): Command {
  return new Command('ls')
    .description('List sandboxes')
    .option('-s, --status <status>', 'Filter by status')
    .option('--json', 'Output as JSON')
    .action(async (options: { status?: SandboxStatus; json?: boolean }) => {
      try {
        const client = getClient()
        const res = await client._http.request<ListSandboxesResponse>({
          method: 'GET',
          path: '/v1/sandboxes',
          query: { status: options.status },
        })

        if (options.json) {
          printJson(res.sandboxes)
          return
        }

        if (res.sandboxes.length === 0) {
          console.log('No sandboxes found.')
          return
        }

        const headers = ['ID', 'STATUS', 'IMAGE', 'PROFILE', 'AGE', 'REPLAY']
        console.log(
          headers
            .map((h, i) => (i < COL_WIDTHS.length ? h.padEnd(COL_WIDTHS[i]!) : h))
            .join('  '),
        )
        console.log(
          [...COL_WIDTHS, 40].map((w) => '\u2500'.repeat(w)).join('  '),
        )

        for (const sb of res.sandboxes) {
          console.log(
            [
              sb.sandbox_id.padEnd(COL_WIDTHS[0]),
              statusColor(sb.status.padEnd(COL_WIDTHS[1])),
              sb.image.padEnd(COL_WIDTHS[2]),
              sb.profile.padEnd(COL_WIDTHS[3]),
              formatAge(sb.created_at).padEnd(COL_WIDTHS[4]),
              sb.replay_url,
            ].join('  '),
          )
        }
      } catch (err) {
        handleError(err)
      }
    })
}
