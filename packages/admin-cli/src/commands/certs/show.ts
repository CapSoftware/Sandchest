import { Command } from 'commander'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig } from '../../config.js'
import { exec } from '../../shell.js'
import { header, info, error, handleError } from '../../output.js'

export function certsShowCommand(): Command {
  return new Command('show')
    .description('Display certificate details (expiry, CN, fingerprint)')
    .option('--dir <dir>', 'Certificates directory (overrides config)')
    .action(async (opts: { dir?: string }) => {
      try {
        const config = readConfig()
        const certsDir = opts.dir ?? config.certs?.dir
        if (!certsDir || !existsSync(certsDir)) {
          error(`Certificates directory not found: ${certsDir ?? '(not configured)'}`)
          info("Run 'sandchest-admin certs generate' first.")
          process.exit(1)
        }

        const pemFiles = readdirSync(certsDir).filter((f) => f.endsWith('.pem'))
        if (pemFiles.length === 0) {
          error(`No .pem files found in ${certsDir}`)
          process.exit(1)
        }

        for (const file of pemFiles) {
          const certPath = join(certsDir, file)
          header(file)

          const result = await exec('openssl', [
            'x509', '-noout', '-subject', '-issuer', '-enddate', '-fingerprint', '-sha256',
            '-in', certPath,
          ])

          if (result.code !== 0) {
            error(`  Failed to read ${file}: ${result.stderr.trim()}`)
          } else {
            for (const line of result.stdout.trim().split('\n')) {
              console.log(`  ${line}`)
            }
          }
        }
      } catch (err) {
        handleError(err)
      }
    })
}
