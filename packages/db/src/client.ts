import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './schema/index'

export function createDatabase(url: string) {
  const pool = mysql.createPool({ uri: url, waitForConnections: true, connectionLimit: 10 })
  return drizzle(pool, { schema, mode: 'default' })
}

export type Database = ReturnType<typeof createDatabase>
