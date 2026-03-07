import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const skillDir = join(repoRoot, 'skills/sandchest')
const agentSkillLink = join(repoRoot, '.agents/skills/sandchest')
const claudeSkillLink = join(repoRoot, '.claude/skills/sandchest')

describe('sandchest skill files', () => {
  test('skill bundle exists with its reference docs', () => {
    const files = [
      'SKILL.md',
      'references/fork-patterns.md',
      'references/image-selection.md',
      'references/troubleshooting.md',
    ]

    for (const file of files) {
      expect(existsSync(join(skillDir, file))).toBe(true)
    }

    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    expect(skill).toContain('name: sandchest')
    expect(skill).toContain('sandbox_git_clone')
    expect(skill).toContain('references/fork-patterns.md')
    expect(skill).toContain('No preview URLs')
  })

  test('repo skill wiring points .agents and .claude at the shared skill bundle', () => {
    expect(lstatSync(agentSkillLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(agentSkillLink)).toBe('../../skills/sandchest')
    expect(lstatSync(claudeSkillLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(claudeSkillLink)).toBe('../../.agents/skills/sandchest')
  })
})
