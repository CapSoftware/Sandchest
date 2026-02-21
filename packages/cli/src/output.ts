import chalk from 'chalk'
import { SandchestError, AuthenticationError } from '@sandchest/sdk'

export function success(msg: string): void {
  console.log(`${chalk.green('✓')} ${msg}`)
}

export function error(msg: string): void {
  console.error(`${chalk.red('✗')} ${msg}`)
}

export function info(msg: string): void {
  console.log(chalk.dim(msg))
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function formatAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function statusColor(status: string): string {
  const key = status.trim()
  switch (key) {
    case 'running':
      return chalk.green(status)
    case 'queued':
    case 'provisioning':
    case 'stopping':
      return chalk.yellow(status)
    case 'stopped':
      return chalk.dim(status)
    case 'failed':
    case 'deleted':
      return chalk.red(status)
    default:
      return status
  }
}

export function handleError(err: unknown): never {
  if (err instanceof AuthenticationError) {
    error('Authentication failed. Run `sandchest auth login --key <api-key>` to set your API key.')
    process.exit(3)
  }
  if (err instanceof SandchestError) {
    error(`${err.message} (${err.code})`)
    process.exit(3)
  }
  if (err instanceof Error) {
    error(err.message)
    process.exit(2)
  }
  error(String(err))
  process.exit(2)
}
