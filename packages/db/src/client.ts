import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './schema/index.js'

export function createDatabase(url: string, opts?: { connectionLimit?: number }) {
  const pool = mysql.createPool({ uri: url, waitForConnections: true, connectionLimit: opts?.connectionLimit ?? 10 })
  return drizzle(pool, { schema, mode: 'default' })
}

export type Database = ReturnType<typeof createDatabase>
