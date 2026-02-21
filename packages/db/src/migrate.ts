import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
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

  const pool = mysql.createPool({
    uri: databaseUrl,
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
