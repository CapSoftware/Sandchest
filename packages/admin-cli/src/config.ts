import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface AdminConfig {
  hetzner?: {
    host?: string | undefined
    sshKeyPath?: string | undefined
    sshUser?: string | undefined
    sshPort?: number | undefined
  } | undefined
  fly?: {
    appName?: string | undefined
    region?: string | undefined
    org?: string | undefined
  } | undefined
  r2?: {
    endpoint?: string | undefined
    accessKeyId?: string | undefined
    secretAccessKey?: string | undefined
    bucket?: string | undefined
  } | undefined
  db?: {
    url?: string | undefined
  } | undefined
  certs?: {
    dir?: string | undefined
  } | undefined
  node?: {
    id?: string | undefined
    grpcPort?: number | undefined
    outboundIface?: string | undefined
  } | undefined
  api?: {
    baseUrl?: string | undefined
  } | undefined
}

export function getConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  const base = xdg ?? join(homedir(), '.config')
  return join(base, 'sandchest')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'admin.json')
}

export function readConfig(): AdminConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AdminConfig
  } catch {
    return {}
  }
}

export function writeConfig(config: AdminConfig): void {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  const configPath = getConfigPath()
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  chmodSync(configPath, 0o600)
}

export function requireConfig(config: AdminConfig, ...fields: string[]): void {
  for (const field of fields) {
    const parts = field.split('.')
    let current: unknown = config
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        current = undefined
        break
      }
      current = (current as Record<string, unknown>)[part]
    }
    if (current == null) {
      throw new Error(`Missing config field '${field}'. Run 'sandchest-admin init' first.`)
    }
  }
}
