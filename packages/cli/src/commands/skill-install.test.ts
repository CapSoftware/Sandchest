import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { resolveBundledSkillDir, skillInstallCommand } from './skill-install.js'

describe('skill install command', () => {
  let tempDir: string
  let previousCwd: string
  let previousHome: string | undefined
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-skill-install-'))
    previousCwd = process.cwd()
    previousHome = process.env['HOME']
    process.chdir(tempDir)
    process.env['HOME'] = tempDir
    process.env['NO_COLOR'] = '1'
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.chdir(previousCwd)
    rmSync(tempDir, { recursive: true, force: true })
    if (previousHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = previousHome
    }
    delete process.env['NO_COLOR']
    logSpy.mockRestore()
  })

  test('installs the bundled skill into the project .claude directory', async () => {
    const program = new Command().addCommand(new Command('skill').addCommand(skillInstallCommand()))
    await program.parseAsync(['node', 'test', 'skill', 'install'])

    const targetSkill = join(tempDir, '.claude', 'skills', 'sandchest')
    const bundledSkill = resolveBundledSkillDir()

    expect(existsSync(join(targetSkill, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(targetSkill, 'SKILL.md'), 'utf-8')).toBe(
      readFileSync(join(bundledSkill, 'SKILL.md'), 'utf-8'),
    )
    expect(existsSync(join(targetSkill, 'references', 'fork-patterns.md'))).toBe(true)
    expect(existsSync(join(targetSkill, 'references', 'image-selection.md'))).toBe(true)
    expect(existsSync(join(targetSkill, 'references', 'troubleshooting.md'))).toBe(true)
  })

  test('installs globally with --global', async () => {
    const program = new Command().addCommand(new Command('skill').addCommand(skillInstallCommand()))
    await program.parseAsync(['node', 'test', 'skill', 'install', '--global'])

    expect(existsSync(join(tempDir, '.claude', 'skills', 'sandchest', 'SKILL.md'))).toBe(true)
  })

  test('does not overwrite a newer installed version without --force', async () => {
    const targetSkill = join(tempDir, '.claude', 'skills', 'sandchest')
    mkdirSync(targetSkill, { recursive: true })
    writeFileSync(
      join(targetSkill, 'SKILL.md'),
      `---\nname: sandchest\nversion: 9.0.0\ndescription: test\n---\n\n# Newer\n`,
      'utf-8',
    )

    const program = new Command().addCommand(new Command('skill').addCommand(skillInstallCommand()))
    await program.parseAsync(['node', 'test', 'skill', 'install'])

    expect(readFileSync(join(targetSkill, 'SKILL.md'), 'utf-8')).toContain('version: 9.0.0')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Use --force to overwrite'))
  })

  test('overwrites an existing install with --force', async () => {
    const targetSkill = join(tempDir, '.claude', 'skills', 'sandchest')
    mkdirSync(targetSkill, { recursive: true })
    writeFileSync(
      join(targetSkill, 'SKILL.md'),
      `---\nname: sandchest\nversion: 9.0.0\ndescription: test\n---\n\n# Newer\n`,
      'utf-8',
    )

    const program = new Command().addCommand(new Command('skill').addCommand(skillInstallCommand()))
    await program.parseAsync(['node', 'test', 'skill', 'install', '--force'])

    expect(readFileSync(join(targetSkill, 'SKILL.md'), 'utf-8')).toContain('version: "1.0.0"')
  })
})
