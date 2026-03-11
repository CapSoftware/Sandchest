import { Command } from 'commander'
import { getClient } from '../config.js'
import { printJson, handleError } from '../output.js'

export function imagesCommand(): Command {
  return new Command('images')
    .description('List available sandbox images')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const client = getClient()
        const res = await client._http.request<{
          images: Array<{
            id: string
            os_version: string
            toolchain: string
            description: string
          }>
        }>({
          method: 'GET',
          path: '/v1/images',
        })

        if (options.json) {
          printJson(res)
        } else {
          console.log('AVAILABLE IMAGES')
          for (const img of res.images) {
            const padded = img.id.padEnd(25)
            console.log(`  ${padded} ${img.description}`)
          }
        }
      } catch (err) {
        handleError(err)
      }
    })
}
