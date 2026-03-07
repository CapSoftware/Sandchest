import { Command } from 'commander'
import { readConfig } from '../../config.js'
import { handleError, header, info, success, warn } from '../../output.js'
import { runSandboxSmokeTest, type SmokeProfile } from '../../sandbox-smoke.js'

export function sandboxSmokeCommand(): Command {
  return new Command('smoke')
    .description('Run a live sandbox smoke test against the configured API')
    .option('--api-key <apiKey>', 'Sandchest API key (defaults to SANDCHEST_API_KEY)')
    .option('--base-url <url>', 'API base URL (defaults to config.api.baseUrl or production)')
    .option('--image <image>', 'Image reference to use for sandbox creation')
    .option('--profile <profile>', 'Sandbox profile (small, medium, large)', 'small')
    .option('--ttl-seconds <seconds>', 'Sandbox TTL in seconds', (value) => parseInt(value, 10), 600)
    .action(async (options: {
      apiKey?: string | undefined
      baseUrl?: string | undefined
      image?: string | undefined
      profile?: string | undefined
      ttlSeconds?: number | undefined
    }) => {
      try {
        const config = readConfig()
        header('Sandbox Smoke Test')
        info(`Target API: ${(options.baseUrl || config.api?.baseUrl || 'https://api.sandchest.com').replace(/\/$/, '')}`)
        info('This command creates live sandboxes in the target environment and always attempts cleanup.')

        const result = await runSandboxSmokeTest({
          apiKey: options.apiKey ?? process.env['SANDCHEST_API_KEY'] ?? '',
          baseUrl: options.baseUrl || config.api?.baseUrl,
          image: options.image,
          profile: options.profile as SmokeProfile | undefined,
          ttlSeconds: options.ttlSeconds,
          logger: {
            info,
            step: (_label, message) => info(message),
            warn,
          },
        })

        success(`Sandbox smoke passed (${result.checks.length} checks)`)
        info(`Run ID: ${result.runId}`)
        info(`Root sandbox: ${result.rootSandboxId}`)
        info(`Fork sandbox: ${result.forkSandboxId}`)
      } catch (error) {
        handleError(error)
      }
    })
}
