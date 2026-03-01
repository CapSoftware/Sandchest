import { spawn, type SpawnOptions } from 'node:child_process'
import { accessSync } from 'node:fs'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export function exec(
  cmd: string,
  args: string[],
  opts?: { cwd?: string | undefined; env?: Record<string, string> | undefined; inherit?: boolean | undefined },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: opts?.inherit ? 'inherit' : 'pipe',
    }
    const child = spawn(cmd, args, spawnOpts)

    let stdout = ''
    let stderr = ''

    if (!opts?.inherit) {
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
    }

    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

export function execInherit(
  cmd: string,
  args: string[],
  opts?: { cwd?: string | undefined; env?: Record<string, string> | undefined },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/**
 * Clean env for flyctl — bun auto-loads .env which may contain a stale FLY_ACCESS_TOKEN
 * that overrides the user's `flyctl auth login` session.
 */
function cleanFlyEnv(): Record<string, string> {
  // Set to '' rather than delete — bun auto-loads .env and re-injects deleted vars into children
  return { ...process.env, FLY_ACCESS_TOKEN: '' } as Record<string, string>
}

/** Run flyctl with FLY_ACCESS_TOKEN cleared from env */
export function flyctl(args: string[]): Promise<ExecResult> {
  return exec('flyctl', args, { env: cleanFlyEnv() })
}

/** Run flyctl with inherited stdio (streaming output) */
export function flyctlInherit(args: string[]): Promise<number> {
  return execInherit('flyctl', args, { env: cleanFlyEnv() })
}

export function commandExists(cmd: string): boolean {
  try {
    accessSync(cmd)
    return true
  } catch {
    // Fall through to PATH check
  }
  const pathDirs = (process.env['PATH'] ?? '').split(':')
  for (const dir of pathDirs) {
    try {
      accessSync(`${dir}/${cmd}`)
      return true
    } catch {
      // continue
    }
  }
  return false
}
