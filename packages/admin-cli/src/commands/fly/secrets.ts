import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { readConfig, requireConfig } from '../../config.js'
import { exec, commandExists } from '../../shell.js'
import { success, step, warn, error, info, handleError } from '../../output.js'

const SECRET_KEYS = [
  // Required
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  // Auth config
  'BETTER_AUTH_BASE_URL',
  // Redis (set REDIS_FAMILY=6 for Upstash IPv6 on Fly.io)
  'REDIS_URL',
  'REDIS_FAMILY',
  // mTLS certificates (PEM content, read from cert files)
  'MTLS_CA_PEM',
  'MTLS_CLIENT_CERT_PEM',
  'MTLS_CLIENT_KEY_PEM',
  // Node daemon gRPC
  'NODE_GRPC_ADDR',
  'NODE_GRPC_NODE_ID',
  // S3-compatible object storage (Cloudflare R2)
  'SANDCHEST_S3_ENDPOINT',
  'SANDCHEST_S3_ACCESS_KEY',
  'SANDCHEST_S3_SECRET_KEY',
  'SANDCHEST_S3_REGION',
  'ARTIFACT_BUCKET_NAME',
  // Admin
  'ADMIN_API_TOKEN',
] as const

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question}: `, (answer) => {
      resolve(answer.trim())
    })
  })
}

export function flySecretsCommand(): Command {
  return new Command('secrets')
    .description('Set all Fly.io secrets (interactive or --from-env)')
    .option('--from-env', 'Read secret values from environment variables')
    .option('--stage', 'Stage secrets without deploying', true)
    .action(async (opts: { fromEnv?: boolean; stage?: boolean }) => {
      try {
        if (!commandExists('flyctl')) {
          error('flyctl not found. Install it: https://fly.io/docs/flyctl/install/')
          process.exit(1)
        }

        const config = readConfig()
        requireConfig(config, 'fly.appName')
        const appName = config.fly!.appName!

        const secrets: Record<string, string> = {}

        // Map of secrets that can be auto-populated from admin config
        const configDefaults: Record<string, string | undefined> = {
          'SANDCHEST_S3_ENDPOINT': config.r2?.endpoint,
          'SANDCHEST_S3_ACCESS_KEY': config.r2?.accessKeyId,
          'SANDCHEST_S3_SECRET_KEY': config.r2?.secretAccessKey,
          'ARTIFACT_BUCKET_NAME': config.r2?.bucket,
          'SANDCHEST_S3_REGION': 'auto',
          'NODE_GRPC_ADDR': config.hetzner?.host ? `${config.hetzner.host}:${config.node?.grpcPort ?? 50051}` : undefined,
          'BETTER_AUTH_BASE_URL': config.api?.baseUrl,
          'REDIS_FAMILY': '6',
        }

        const certFileMap: Record<string, string> = {
          'MTLS_CA_PEM': 'ca.pem',
          'MTLS_CLIENT_CERT_PEM': 'client.pem',
          'MTLS_CLIENT_KEY_PEM': 'client.key',
        }

        function tryReadCert(key: string): string | undefined {
          const certsDir = config.certs?.dir
          const fileName = certFileMap[key]
          if (!certsDir || !fileName) return undefined
          const filePath = join(certsDir, fileName)
          if (!existsSync(filePath)) return undefined
          info(`  ${key} read from ${filePath}`)
          return readFileSync(filePath, 'utf-8')
        }

        if (opts.fromEnv) {
          step('[1/2]', 'Reading secrets from environment and config...')
          for (const key of SECRET_KEYS) {
            const value = process.env[key]
            if (value) {
              secrets[key] = value
            } else if (key in certFileMap) {
              const pem = tryReadCert(key)
              if (pem) {
                secrets[key] = pem
              } else {
                warn(`  ${key} not set and cert file not found`)
              }
            } else if (configDefaults[key]) {
              secrets[key] = configDefaults[key]!
              info(`  ${key} populated from admin config`)
            } else {
              warn(`  ${key} not set in environment`)
            }
          }
        } else {
          step('[1/2]', 'Interactive secrets setup...')
          info('Press Enter to skip (or accept default). mTLS certs auto-read from certs.dir if configured.')

          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            for (const key of SECRET_KEYS) {
              if (key in certFileMap) {
                const pem = tryReadCert(key)
                if (pem) {
                  secrets[key] = pem
                  continue
                }
              }
              const defaultVal = configDefaults[key]
              const hint = defaultVal ? ` [${defaultVal}]` : ''
              const value = await prompt(rl, `${key}${hint}`)
              if (value) {
                secrets[key] = value
              } else if (defaultVal) {
                secrets[key] = defaultVal
                info(`  ${key} = ${defaultVal} (from config)`)
              }
            }
          } finally {
            rl.close()
          }
        }

        const secretCount = Object.keys(secrets).length
        if (secretCount === 0) {
          warn('No secrets to set')
          return
        }

        step('[2/2]', `Setting ${secretCount} secrets on ${appName}...`)
        const secretArgs = Object.entries(secrets).map(([k, v]) => `${k}=${v}`)
        const flyArgs = ['secrets', 'set', ...secretArgs, '-a', appName]
        if (opts.stage) flyArgs.push('--stage')

        const result = await exec('flyctl', flyArgs)
        if (result.code !== 0) {
          error(result.stderr.trim() || result.stdout.trim())
          process.exit(1)
        }

        success(`${secretCount} secrets set on ${appName}${opts.stage ? ' (staged)' : ''}`)
      } catch (err) {
        handleError(err)
      }
    })
}
