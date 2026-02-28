import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { execInherit } from '../../shell.js'
import { step, error, success, handleError } from '../../output.js'

export function dbSeedCommand(): Command {
  return new Command('seed')
    .description('Seed database with profiles and images')
    .action(async () => {
      try {
        const config = readConfig()
        requireConfig(config, 'db.url')

        step('[1/1]', 'Seeding database...')
        const code = await execInherit('bun', ['run', 'db:seed'], {
          env: { DATABASE_URL: config.db!.url! },
        })

        if (code !== 0) {
          error(`Seed failed with exit code ${code}`)
          process.exit(code)
        }

        success('Database seeded')
      } catch (err) {
        handleError(err)
      }
    })
}
