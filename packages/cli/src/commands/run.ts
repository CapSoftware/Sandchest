import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Command, Option } from 'commander'
import { getClient } from '../config.js'
import { detectProject } from '../detect.js'
import { handleError } from '../output.js'
import { createLocalArchive } from './copy.js'

function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function collectExclude(value: string, previous: string[]): string[] {
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

export function runCommand(): Command {
  return new Command('run')
    .description('Upload project and run a command in a sandbox')
    .argument('<cmd>', 'Command to execute (quote shell expressions)')
    .option('--image <image>', 'Override auto-detected image')
    .addOption(
      new Option('--profile <profile>', 'Resource profile').choices(['small', 'medium', 'large']).default('small'),
    )
    .option('--keep', 'Keep sandbox alive after command completes')
    .option('--no-install', 'Skip dependency installation')
    .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable)', collectEnv, [])
    .option('--timeout <seconds>', 'Command timeout in seconds', '300')
    .option('--exclude <pattern>', 'Exclude pattern for upload (repeatable)', collectExclude, [])
    .option('--dir <path>', 'Local directory to upload (defaults to cwd)')
    .option('--json', 'Output as JSON')
    .action(async (cmd: string, opts) => {
      const localDir = resolve(opts.dir ?? process.cwd())
      const detection = detectProject(localDir)
      const image = opts.image ?? detection.image
      const env = opts.env.length > 0 ? parseEnvPairs(opts.env) : undefined

      let sandboxId: string | undefined

      try {
        const client = getClient()

        // Step 1: Create sandbox
        process.stderr.write(`Creating sandbox (${image})...\n`)
        const sandbox = await client.create({
          image,
          profile: opts.profile as 'small' | 'medium' | 'large',
          env,
        })
        sandboxId = sandbox.id
        process.stderr.write(`Sandbox ${sandbox.id} ready\n`)

        // Step 2: Upload project
        process.stderr.write('Uploading project...\n')
        const archivePath = join(tmpdir(), `.sandchest-run-${crypto.randomUUID()}.tar.gz`)
        try {
          createLocalArchive(localDir, archivePath, { exclude: opts.exclude })
          const tarball = new Uint8Array(readFileSync(archivePath))
          const sizeMb = (tarball.byteLength / 1024 / 1024).toFixed(1)
          await sandbox.fs.uploadDir('/work', tarball)
          process.stderr.write(`Uploaded ${sizeMb} MB\n`)
        } finally {
          rmSync(archivePath, { force: true })
        }

        // Step 3: Install dependencies
        if (opts.install !== false && detection.installCmd) {
          process.stderr.write(`Installing dependencies (${detection.installCmd})...\n`)
          const installResult = await sandbox.exec(detection.installCmd, { cwd: '/work', timeout: 300 })
          if (installResult.exitCode !== 0) {
            if (installResult.stderr) process.stderr.write(installResult.stderr)
            process.stderr.write(`Dependency install failed (exit ${installResult.exitCode})\n`)
            process.exit(installResult.exitCode)
          }
          process.stderr.write('Dependencies installed\n')
        }

        // Step 4: Run command with streaming output
        process.stderr.write(`Running: ${cmd}\n`)
        const timeout = parseInt(opts.timeout, 10)
        const result = await sandbox.exec(cmd, {
          cwd: '/work',
          timeout: isNaN(timeout) ? 300 : timeout,
          onStdout: (data: string) => process.stdout.write(data),
          onStderr: (data: string) => process.stderr.write(data),
        })

        // Step 5: Print replay URL
        process.stderr.write(`\nReplay: ${sandbox.replayUrl}\n`)

        if (opts.json) {
          const output = JSON.stringify({
            sandbox_id: sandbox.id,
            exit_code: result.exitCode,
            replay_url: sandbox.replayUrl,
            duration_ms: result.durationMs,
          }, null, 2)
          console.log(output)
        }

        // Step 6: Cleanup
        if (!opts.keep) {
          await sandbox.destroy().catch(() => {})
        } else {
          process.stderr.write(`Sandbox kept alive: ${sandbox.id}\n`)
        }

        process.exit(result.exitCode)
      } catch (err) {
        // Clean up sandbox on error
        if (sandboxId && !opts.keep) {
          try {
            const client = getClient()
            const sb = await client.get(sandboxId)
            await sb.destroy()
          } catch {
            // best effort
          }
        }
        handleError(err)
      }
    })
}
