import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Sandchest } from '@sandchest/sdk'

export interface CliConfig {
  apiKey?: string | undefined
  baseUrl?: string | undefined
}

export function getConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  const base = xdg ?? join(homedir(), '.config')
  return join(base, 'sandchest')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export function readConfig(): CliConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as CliConfig
  } catch {
    return {}
  }
}

export function writeConfig(config: CliConfig): void {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function getApiKey(): string | undefined {
  return process.env['SANDCHEST_API_KEY'] ?? readConfig().apiKey
}

export function getClient(): Sandchest {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error(
      'Not authenticated. Run `sandchest auth login --key <api-key>` to get started.',
    )
  }
  const config = readConfig()
  return new Sandchest({ apiKey, baseUrl: config.baseUrl })
}
