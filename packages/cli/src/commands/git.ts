import { Command } from 'commander'
import { ExecFailedError } from '@sandchest/sdk'
import { getClient } from '../config.js'
import { success, info, printJson, handleError } from '../output.js'

function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx === -1) {
      throw new Error(`Invalid env format: "${pair}". Use KEY=VALUE.`)
    }
    env[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return env
}

function isScpStyleGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+$/.test(value)
}

function validateGitCloneUrl(
  rawUrl: string,
  options?: { allowNonHttps?: boolean | undefined },
): { ok: true; url: string } | { ok: false; error: string } {
  const url = rawUrl.trim()
  if (url === '') {
    return { ok: false, error: 'Git URL must not be empty.' }
  }

  if (isScpStyleGitUrl(url)) {
    if (options?.allowNonHttps) {
      return { ok: true, url }
    }
    return {
      ok: false,
      error: 'Only HTTPS URLs are allowed by default. Got: ssh-style URL. Pass --allow-non-https for SSH or git:// URLs.',
    }
  }

  if (!url.includes('://')) {
    return {
      ok: false,
      error: `Invalid git URL: ${url}. Use an HTTPS URL or an SSH-style URL such as git@github.com:org/repo.git.`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: `Invalid git URL: ${url}.` }
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        'URLs with embedded credentials (user:pass@host) are not allowed. Private-repo auth is intentionally deferred until Sandchest can inject credentials outside the guest boundary.',
    }
  }

  if (!options?.allowNonHttps && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `Only HTTPS URLs are allowed by default. Got: ${parsed.protocol.replace(/:$/, '')}://... Pass --allow-non-https for SSH or git:// URLs.`,
    }
  }

  return { ok: true, url }
}

function gitCloneCommand(): Command {
  return new Command('clone')
    .description('Clone a git repository into a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<url>', 'Repository URL')
    .argument('[dest]', 'Destination path in the sandbox', '/work')
    .option('--branch <branch>', 'Branch or tag to check out')
    .option('--depth <depth>', 'Shallow clone depth', parseInt)
    .option('--all-branches', 'Clone all branches instead of a single branch')
    .option('--allow-non-https', 'Allow non-HTTPS URLs such as SSH or git://')
    .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable)', collectEnv, [])
    .option('--timeout <seconds>', 'Timeout in seconds', parseInt)
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        url: string,
        dest: string | undefined,
        options: {
          branch?: string
          depth?: number
          allBranches?: boolean
          allowNonHttps?: boolean
          env: string[]
          timeout?: number
          json?: boolean
        },
      ) => {
        try {
          const cloneDest = dest ?? '/work'
          const env = options.env.length > 0 ? parseEnvPairs(options.env) : undefined
          const validated = validateGitCloneUrl(url, { allowNonHttps: options.allowNonHttps })
          if (!validated.ok) {
            throw new ExecFailedError({
              operation: 'git.clone',
              exitCode: 1,
              stderr: validated.error,
            })
          }

          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const result = await sandbox.git.clone(validated.url, {
            dest: cloneDest,
            branch: options.branch,
            depth: options.depth,
            singleBranch: options.allBranches ? false : undefined,
            env,
            timeout: options.timeout ?? 120,
          })

          if (options.json) {
            printJson({
              sandbox_id: sandboxId,
              url: validated.url,
              dest: cloneDest,
              exec_id: result.execId,
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              duration_ms: result.durationMs,
            })
          } else {
            success(`Cloned ${validated.url} → ${cloneDest}`)
            info(`Exec:      ${result.execId}`)
            info(`Duration:  ${result.durationMs}ms`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )
}

export function gitCommand(): Command {
  return new Command('git')
    .description('Git operations inside a sandbox')
    .addCommand(gitCloneCommand())
}
