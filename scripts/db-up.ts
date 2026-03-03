/**
 * Start local MySQL via Docker and run migrations + seed.
 *
 * Usage: bun run scripts/db-up.ts
 * Skips entirely when CI=true (GitHub Actions uses its own MySQL service).
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// Skip in CI — GitHub Actions provisions its own MySQL service
if (process.env.CI === 'true') {
  console.log('CI detected, skipping Docker MySQL setup')
  process.exit(0)
}

// Check Docker is available
try {
  await $`docker info`.quiet()
} catch {
  console.error(
    'Docker is not running. Please install and start Docker Desktop:\n' +
      '  https://docs.docker.com/get-docker/',
  )
  process.exit(1)
}

// Start MySQL container (idempotent, waits for health check)
console.log('Starting MySQL container...')
await $`docker compose -f ${root}/docker-compose.yml up -d --wait`

// Bun auto-loads .env from the project root
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL not set in .env')
  process.exit(1)
}

// Ensure the app user + database exist and have correct credentials.
// If the Docker volume predates the current docker-compose env vars,
// MariaDB will NOT have created the user. Fix via root.
console.log('Ensuring database credentials...')
await $`docker exec sandchest-mysql mariadb -uroot -psandchest -e ${`
  CREATE DATABASE IF NOT EXISTS sandchest;
  CREATE USER IF NOT EXISTS 'sandchest'@'%' IDENTIFIED BY 'sandchest';
  ALTER USER 'sandchest'@'%' IDENTIFIED BY 'sandchest';
  GRANT ALL PRIVILEGES ON sandchest.* TO 'sandchest'@'%';
  FLUSH PRIVILEGES;
`}`.quiet()
console.log('  Ready.')

// Run migrations
console.log('Running migrations...')
const { runMigrations } = await import('../packages/db/src/migrate')
const result = await runMigrations({ databaseUrl })
if (result.betterAuthMigration) console.log('  - BetterAuth schema applied')
if (result.drizzleMigrations) console.log('  - Drizzle migrations applied')

// Seed data
console.log('Seeding database...')
const { createDatabase } = await import('../packages/db/src/client')
const { seedDev } = await import('../packages/db/src/seed')
const db = createDatabase(databaseUrl)
await seedDev(db)
console.log('  - Seed data applied (production + dev)')

console.log('Local database ready.')
process.exit(0)
