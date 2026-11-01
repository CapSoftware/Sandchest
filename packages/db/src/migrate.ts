import { fileURLToPath } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

/** The SQL migrations shipped with this package. */
export function migrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

/**
 * Applies pending migrations. Concurrent runs are not safe on their own:
 * self-hosted servers hold an advisory lock around this (apps/web/scripts/migrate.ts).
 */
export async function migrate(database: Db, folder = migrationsDir()): Promise<void> {
  await runMigrations(database, { migrationsFolder: folder });
}

/** Applies another package's drizzle migrations, tracked in its own table. */
export async function migrateFolder(database: Db, folder: string, tracking: { table: string; schema: string }): Promise<void> {
  await runMigrations(database, { migrationsFolder: folder, migrationsTable: tracking.table, migrationsSchema: tracking.schema });
}
