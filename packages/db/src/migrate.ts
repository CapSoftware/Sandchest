import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface MigrateOptions {
  databaseUrl: string
  /** Run BetterAuth schema migration before Drizzle migrations. Defaults to true. */
  betterAuth?: boolean | undefined
}

export interface MigrateResult {
  drizzleMigrations: boolean
  betterAuthMigration: boolean
}

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

/**
 * Check whether a single migration's schema changes have already been applied.
 * Supports CREATE TABLE and ALTER TABLE ADD COLUMN statements.
 * Returns true only if every statement in the migration is already reflected in the DB.
 */
async function isMigrationApplied(pool: mysql.Pool, migrationSql: string): Promise<boolean> {
  const statements = migrationSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  for (const stmt of statements) {
    // ALTER TABLE `x` ADD `y` ...
    const addCol = stmt.match(
      /ALTER\s+TABLE\s+`(\w+)`\s+ADD\s+(?:COLUMN\s+)?`(\w+)`/i,
    )
    if (addCol) {
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [addCol[1], addCol[2]],
      )
      if ((rows as Array<{ cnt: number }>)[0]?.cnt === 0) return false
      continue
    }

    // CREATE TABLE `x` ...
    const createTbl = stmt.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`(\w+)`/i,
    )
    if (createTbl) {
      const [rows] = await pool.query('SHOW TABLES LIKE ?', [createTbl[1]])
      if ((rows as unknown[]).length === 0) return false
      continue
    }

    // Statement type we can't verify — assume not applied
    return false
  }

  return statements.length > 0
}

/**
 * Ensure the Drizzle journal reflects migrations whose schema changes are
 * already present in the database (e.g. applied via `db:push`).
 *
 * Handles both empty journals and partially populated ones — any migration
 * whose hash is missing from the journal but whose changes already exist in
 * the DB will be seeded so Drizzle doesn't try to re-run it.
 */
async function seedDrizzleJournalIfNeeded(pool: mysql.Pool): Promise<void> {
  // Ensure the journal table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
      \`id\` serial PRIMARY KEY,
      \`hash\` text NOT NULL,
      \`created_at\` bigint
    )
  `)

  // Check if app tables exist (canary: sandboxes)
  const [tables] = await pool.query(`SHOW TABLES LIKE 'sandboxes'`)
  if ((tables as unknown[]).length === 0) return // fresh DB, nothing to seed

  // Collect hashes already in the journal
  const [existingRows] = await pool.query('SELECT `hash` FROM `__drizzle_migrations`')
  const existingHashes = new Set(
    (existingRows as Array<{ hash: string }>).map((r) => r.hash),
  )

  // Read the Drizzle journal to find all migration entries
  const journalPath = resolve(__dirname, '..', 'drizzle', 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: JournalEntry[]
  }

  for (const entry of journal.entries) {
    const sqlPath = resolve(__dirname, '..', 'drizzle', `${entry.tag}.sql`)
    const sql = readFileSync(sqlPath, 'utf-8')
    const hash = createHash('sha256').update(sql).digest('hex')

    if (existingHashes.has(hash)) continue // already recorded

    // Only seed if the migration's changes are already in the DB
    const applied = await isMigrationApplied(pool, sql)
    if (!applied) continue

    await pool.query(
      'INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)',
      [hash, entry.when],
    )
  }
}

/**
 * Run all database migrations programmatically.
 *
 * 1. Applies BetterAuth schema (idempotent CREATE TABLE IF NOT EXISTS)
 * 2. Applies Drizzle-managed migrations from packages/db/drizzle/
 *
 * Safe to run multiple times — both steps are idempotent.
 */
export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const { databaseUrl, betterAuth = true } = options
  const trimmedDatabaseUrl = databaseUrl.trim()

  if (trimmedDatabaseUrl === '') {
    throw new Error('databaseUrl is required')
  }

  const pool = mysql.createPool({
    uri: trimmedDatabaseUrl,
    waitForConnections: true,
    connectionLimit: 2,
    multipleStatements: true,
  })

  const result: MigrateResult = {
    drizzleMigrations: false,
    betterAuthMigration: false,
  }

  try {
    // Step 1: Apply BetterAuth schema (raw SQL, idempotent)
    if (betterAuth) {
      const migrationPath = resolve(__dirname, '..', 'migrations', '001_betterauth_schema.sql')
      const rawSql = readFileSync(migrationPath, 'utf-8')
      // Convert CREATE TABLE to CREATE TABLE IF NOT EXISTS for idempotency
      const idempotentSql = rawSql.replace(
        /CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/gi,
        'CREATE TABLE IF NOT EXISTS',
      )
      await pool.query(idempotentSql)
      result.betterAuthMigration = true
    }

    // Step 2: Apply Drizzle migrations
    // If tables were created via `db:push` the Drizzle journal table is empty
    // but the app tables already exist. Seed the journal so Drizzle doesn't
    // try to re-run the initial migration.
    await seedDrizzleJournalIfNeeded(pool)

    const db = drizzle(pool, { mode: 'default' })
    const migrationsFolder = resolve(__dirname, '..', 'drizzle')
    await drizzleMigrate(db, { migrationsFolder })
    result.drizzleMigrations = true

    return result
  } finally {
    await pool.end()
  }
}

// Run as standalone script: bun run packages/db/src/migrate.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/migrate.ts')) {
  // Load .env from monorepo root (same as drizzle.config.ts)
  const { config } = await import('dotenv')
  config({ path: resolve(__dirname, '..', '..', '..', '.env') })

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  runMigrations({ databaseUrl })
    .then((result) => {
      console.log('Migrations completed successfully')
      if (result.betterAuthMigration) console.log('  - BetterAuth schema applied')
      if (result.drizzleMigrations) console.log('  - Drizzle migrations applied')
      process.exit(0)
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err)
      process.exit(1)
    })
}
