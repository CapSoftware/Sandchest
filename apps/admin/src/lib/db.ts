import { drizzle } from 'drizzle-orm/mysql2'
import { createPool } from 'mysql2/promise'

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Missing DATABASE_URL env var')
  return url
}

let _db: ReturnType<typeof drizzle> | undefined

export function getDb() {
  if (!_db) {
    _db = drizzle(createPool({
      uri: getDatabaseUrl(),
      waitForConnections: true,
      connectionLimit: 5,
    }))
  }
  return _db
}
