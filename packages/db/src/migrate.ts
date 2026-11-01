import { fileURLToPath } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

/** The SQL migrations shipped with this package. */
export function migrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

/** Applies pending migrations. Safe to run concurrently: drizzle takes a lock. */
export async function migrate(database: Db): Promise<void> {
  await runMigrations(database, { migrationsFolder: migrationsDir() });
}
