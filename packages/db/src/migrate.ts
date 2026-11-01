import { resolve } from "node:path";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");

/** Applies pending migrations. Safe to run concurrently: drizzle takes a lock. */
export async function migrate(database: Db): Promise<void> {
  await runMigrations(database, { migrationsFolder: MIGRATIONS_DIR });
}
