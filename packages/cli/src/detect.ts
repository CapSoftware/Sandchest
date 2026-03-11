import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ProjectDetection {
  image: string
  installCmd: string | null
  workDir: string
}

/**
 * Detect the project type from the current directory.
 * Returns the recommended image, install command, and working directory.
 */
export function detectProject(dir: string): ProjectDetection {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bunfig.toml'))) {
    return { image: 'ubuntu-22.04/bun', installCmd: 'bun install --frozen-lockfile', workDir: '/work' }
  }
  if (existsSync(join(dir, 'package-lock.json'))) {
    return { image: 'ubuntu-22.04/node-22', installCmd: 'npm ci', workDir: '/work' }
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return { image: 'ubuntu-22.04/node-22', installCmd: 'yarn install --frozen-lockfile', workDir: '/work' }
  }
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return { image: 'ubuntu-22.04/node-22', installCmd: 'pnpm install --frozen-lockfile', workDir: '/work' }
  }
  if (existsSync(join(dir, 'pyproject.toml'))) {
    return { image: 'ubuntu-22.04/python-3.12', installCmd: 'pip install -e .', workDir: '/work' }
  }
  if (existsSync(join(dir, 'requirements.txt'))) {
    return { image: 'ubuntu-22.04/python-3.12', installCmd: 'pip install -r requirements.txt', workDir: '/work' }
  }
  if (existsSync(join(dir, 'go.mod'))) {
    return { image: 'ubuntu-22.04/go-1.22', installCmd: 'go mod download', workDir: '/work' }
  }
  return { image: 'ubuntu-22.04/base', installCmd: null, workDir: '/work' }
}
