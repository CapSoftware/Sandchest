import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = resolve(__dirname, '..', 'drizzle')
const betterAuthMigration = resolve(__dirname, '..', 'migrations', '001_betterauth_schema.sql')

describe('migrate', () => {
  test('drizzle migrations folder exists and contains SQL files', () => {
    expect(existsSync(migrationsFolder)).toBe(true)
    const journal = JSON.parse(
      readFileSync(resolve(migrationsFolder, 'meta', '_journal.json'), 'utf-8'),
    )
    expect(journal.entries.length).toBeGreaterThan(0)
    for (const entry of journal.entries) {
      const sqlFile = resolve(migrationsFolder, `${entry.tag}.sql`)
      expect(existsSync(sqlFile)).toBe(true)
    }
  })

  test('drizzle migration journal has valid structure', () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrationsFolder, 'meta', '_journal.json'), 'utf-8'),
    )
    expect(journal.dialect).toBe('mysql')
    expect(Array.isArray(journal.entries)).toBe(true)
    for (const entry of journal.entries) {
      expect(typeof entry.idx).toBe('number')
      expect(typeof entry.tag).toBe('string')
      expect(entry.tag.length).toBeGreaterThan(0)
    }
  })

  test('betterauth migration file exists and is valid SQL', () => {
    expect(existsSync(betterAuthMigration)).toBe(true)
    const sql = readFileSync(betterAuthMigration, 'utf-8')
    expect(sql).toContain('CREATE TABLE')
    expect(sql).toContain('`user`')
    expect(sql).toContain('`session`')
    expect(sql).toContain('`account`')
    expect(sql).toContain('`organization`')
    expect(sql).toContain('`apikey`')
  })

  test('betterauth migration can be made idempotent via regex', () => {
    const sql = readFileSync(betterAuthMigration, 'utf-8')
    const idempotent = sql.replace(
      /CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/gi,
      'CREATE TABLE IF NOT EXISTS',
    )
    // Every CREATE TABLE should now be IF NOT EXISTS
    const createStatements = idempotent.match(/CREATE TABLE/gi) ?? []
    const ifNotExists = idempotent.match(/CREATE TABLE IF NOT EXISTS/gi) ?? []
    expect(createStatements.length).toBe(ifNotExists.length)
    expect(createStatements.length).toBeGreaterThan(0)
  })

  test('runMigrations rejects without DATABASE_URL', async () => {
    const { runMigrations } = await import('./migrate.js')
    // Invalid URL should cause connection failure
    await expect(runMigrations({ databaseUrl: '' })).rejects.toThrow()
  })

  test('runMigrations exports correct interface', async () => {
    const mod = await import('./migrate.js')
    expect(typeof mod.runMigrations).toBe('function')
  })
})
