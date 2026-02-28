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
