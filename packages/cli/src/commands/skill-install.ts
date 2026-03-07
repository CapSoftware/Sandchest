import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { handleError, info, success } from '../output.js'

function parseSkillVersion(contents: string): string | undefined {
  const frontmatterMatch = contents.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    return undefined
  }

  const lines = frontmatterMatch[1].split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim()
    if (line?.startsWith('version:')) {
      return line.slice('version:'.length).trim().replace(/^["']|["']$/g, '')
    }
    if (line === 'metadata:') {
      for (let childIndex = index + 1; childIndex < lines.length; childIndex++) {
        const childLine = lines[childIndex] ?? ''
        if (childLine.trim() === '') {
          continue
        }
        if (!/^\s+/.test(childLine)) {
          break
        }
        const trimmedChild = childLine.trim()
        if (trimmedChild.startsWith('version:')) {
          return trimmedChild.slice('version:'.length).trim().replace(/^["']|["']$/g, '')
        }
      }
      break
    }
  }
  return undefined
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

export function resolveBundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../../skills/sandchest'),
    resolve(here, '../skills/sandchest'),
    resolve(here, '../../../skills/sandchest'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'SKILL.md'))) {
      return candidate
    }
  }

  throw new Error('Bundled sandchest skill assets were not found in this package.')
}

function getHomeDir(): string {
  return process.env['HOME'] ?? homedir()
}

function getInstallTarget(globalInstall: boolean | undefined): string {
  if (globalInstall) {
    return join(getHomeDir(), '.claude', 'skills', 'sandchest')
  }
  return join(process.cwd(), '.claude', 'skills', 'sandchest')
}

function getSkillVersion(skillDir: string): string | undefined {
  return parseSkillVersion(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8'))
}

export function skillInstallCommand(): Command {
  return new Command('install')
    .description('Install the Sandchest skill for Claude Code')
    .option('--global', 'Install into ~/.claude/skills/sandchest')
    .option('--force', 'Overwrite an existing installation even if it is newer')
    .action(async (options: { global?: boolean; force?: boolean }) => {
      try {
        const sourceDir = resolveBundledSkillDir()
        const targetDir = getInstallTarget(options.global)
        const sourceVersion = getSkillVersion(sourceDir)

        if (existsSync(join(targetDir, 'SKILL.md')) && !options.force) {
          const installedVersion = getSkillVersion(targetDir)
          if (installedVersion && sourceVersion && compareVersions(installedVersion, sourceVersion) > 0) {
            info(`A newer sandchest skill is already installed at ${targetDir}. Use --force to overwrite it.`)
            return
          }
          if (installedVersion && sourceVersion && compareVersions(installedVersion, sourceVersion) === 0) {
            info(`sandchest skill ${installedVersion} is already installed at ${targetDir}.`)
            return
          }
        }

        mkdirSync(dirname(targetDir), { recursive: true })
        rmSync(targetDir, { recursive: true, force: true })
        cpSync(sourceDir, targetDir, { recursive: true })

        success(`Installed sandchest skill to ${targetDir}`)
        if (sourceVersion) {
          info(`Version: ${sourceVersion}`)
        }
      } catch (error) {
        handleError(error)
      }
    })
}
