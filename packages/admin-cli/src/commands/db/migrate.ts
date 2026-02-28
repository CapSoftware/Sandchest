import { Command } from 'commander'
import { readConfig, requireConfig } from '../../config.js'
import { execInherit } from '../../shell.js'
import { step, error, success, handleError } from '../../output.js'

export function dbMigrateCommand(): Command {
  return new Command('migrate')
    .description('Run database migrations')
    .action(async () => {
      try {
        const config = readConfig()
        requireConfig(config, 'db.url')

        step('[1/1]', 'Running database migrations...')
        const code = await execInherit('bun', ['run', 'db:migrate:run'], {
          env: { DATABASE_URL: config.db!.url! },
        })

        if (code !== 0) {
          error(`Migration failed with exit code ${code}`)
          process.exit(code)
        }

        success('Database migrations complete')
      } catch (err) {
        handleError(err)
      }
    })
}
