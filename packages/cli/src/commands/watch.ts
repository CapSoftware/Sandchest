import { Command } from 'commander'
import type { ExecStreamEvent } from '@sandchest/contract'
import { getClient } from '../config.js'
import { printJson, handleError } from '../output.js'

async function* parseSSE(response: Response): AsyncGenerator<ExecStreamEvent> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()!

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data) {
              yield JSON.parse(data) as ExecStreamEvent
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function watchCommand(): Command {
  return new Command('watch')
    .description('Stream output from a running execution')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<exec_id>', 'Execution ID')
    .option('--json', 'Output events as JSON lines')
    .action(
      async (
        sandboxId: string,
        execId: string,
        options: { json?: boolean },
      ) => {
        try {
          const client = getClient()
          const response = await client._http.requestRaw({
            method: 'GET',
            path: `/v1/sandboxes/${sandboxId}/exec/${execId}/stream`,
            headers: { Accept: 'text/event-stream' },
          })

          for await (const event of parseSSE(response)) {
            if (options.json) {
              printJson(event)
            } else {
              switch (event.t) {
                case 'stdout':
                  process.stdout.write(event.data)
                  break
                case 'stderr':
                  process.stderr.write(event.data)
                  break
                case 'exit':
                  if (event.code !== 0) process.exit(event.code)
                  break
              }
            }
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}
