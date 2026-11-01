import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

export interface DbOptions {
  /** Connections in the pool. Default 10. */
  max?: number;
  /** Seconds to wait for a connection. Default 10. */
  connectTimeout?: number;
}

/**
 * A pooled connection. Prepared statements are off so the same code works
 * behind transaction-mode poolers (PgBouncer, managed proxies).
 */
export function createDb(url: string, options: DbOptions = {}): Db {
  const client = postgres(url, {
    max: options.max ?? 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: options.connectTimeout ?? 10,
    onnotice: () => {},
  });
  return drizzle(client, { schema }) as Db;
}

let shared: Db | undefined;

/** The process-wide connection for `DATABASE_URL`. */
export function db(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb(url);
  }
  return shared;
}
