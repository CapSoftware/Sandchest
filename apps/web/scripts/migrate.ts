/**
 * Brings a self-hosted database up to date before the server starts: the
 * app's schema, then the Postgres World's (its tables and graphile-worker's
 * queue). Runs on every container start; a no-op when nothing is pending.
 *
 * One advisory lock is held throughout, so servers starting together take
 * turns instead of racing on the same DDL. Bundled into the image as
 * /app/migrate.mjs (docker/Dockerfile), with the SQL folders beside it.
 *
 * Env: DATABASE_MIGRATION_URL (a role that may change the schema) or
 * DATABASE_URL. SANDCHEST_MIGRATIONS and SANDCHEST_WORLD_MIGRATIONS override
 * where the SQL lives.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createDb } from "@sandchest/db";
import { migrate, migrateFolder, migrationsDir } from "@sandchest/db/migrate";
import { makeWorkerUtils } from "graphile-worker";

/** Arbitrary, fixed: "sandchest" in ASCII, as a bigint. */
const LOCK_ID = 0x73616e646368n;

export async function migrateAll(url: string, folders = { app: migrationsDir(), world: worldMigrationsDir() }): Promise<void> {
  // One connection: the lock is held by the session that runs the migrations.
  const database = createDb(url, { max: 1 });
  try {
    await database.$client`select pg_advisory_lock(${LOCK_ID.toString()}::bigint)`;
    const started = performance.now();
    await migrate(database, folders.app);
    // The same tracking table the World's own `bootstrap` command uses, so either can run later.
    await migrateFolder(database, folders.world, { table: "workflow_migrations", schema: "workflow_drizzle" });
    // graphile-worker installs its schema on first start, racily; do it here, under the lock.
    const worker = await makeWorkerUtils({ connectionString: url });
    try {
      await worker.migrate();
    } finally {
      await worker.release();
    }
    console.log(`Database is up to date (${Math.round(performance.now() - started)} ms).`);
  } finally {
    await database.$client.end();
  }
}

/** The World's migrations, in the installed package (src/drizzle/migrations is in its published files). */
function worldMigrationsDir(): string {
  const entry = createRequire(import.meta.url).resolve("@workflow/world-postgres");
  return join(dirname(entry), "..", "src", "drizzle", "migrations");
}

if (import.meta.main) {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL (or DATABASE_MIGRATION_URL) to migrate the database.");
    process.exit(2);
  }
  const app = process.env.SANDCHEST_MIGRATIONS;
  const world = process.env.SANDCHEST_WORLD_MIGRATIONS;
  try {
    await migrateAll(url, app && world ? { app, world } : undefined);
  } catch (error) {
    // The message only: driver errors can carry the connection string.
    console.error(`Migrating the database failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<database url>") : "unknown error"}`);
    process.exit(1);
  }
}
