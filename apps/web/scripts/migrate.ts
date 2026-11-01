/**
 * Brings a self-hosted database up to date before the server starts: the
 * app's schema, then the Postgres World's (its tables and graphile-worker's
 * queue). Runs on every container start; a no-op when nothing is pending.
 *
 * Each part runs under an advisory lock, so servers starting together take
 * turns instead of racing on the same DDL. Bundled into the image as
 * /app/migrate.mjs (docker/Dockerfile), with the SQL folders beside it.
 *
 * Env: DATABASE_URL; DATABASE_MIGRATION_URL for the app's schema and
 * WORKFLOW_POSTGRES_URL for the World's, when they differ from it.
 * SANDCHEST_MIGRATIONS and SANDCHEST_WORLD_MIGRATIONS say where the SQL lives.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createDb, type Db } from "@sandchest/db";
import { migrate, migrateFolder, migrationsDir } from "@sandchest/db/migrate";
import { makeWorkerUtils } from "graphile-worker";

/** Arbitrary, fixed: "sandchest" in ASCII, as bigints. Two, since both may be taken in one database. */
const APP_LOCK = 0x73616e646368n;
const WORLD_LOCK = 0x73616e646369n;

export interface MigrationUrls {
  /** The app's schema: a role that may change it (DATABASE_MIGRATION_URL, else DATABASE_URL). */
  app: string;
  /**
   * The World's tables and queue: the role the World runs as (WORKFLOW_POSTGRES_URL, else
   * DATABASE_URL), since graphile-worker checks its own schema at runtime.
   */
  world: string;
}

export async function migrateAll(urls: MigrationUrls, folders = { app: migrationsDir(), world: worldMigrationsDir() }): Promise<void> {
  const started = performance.now();
  await withLock(urls.app, APP_LOCK, (database) => migrate(database, folders.app));
  await withLock(urls.world, WORLD_LOCK, async (database) => {
    // The same tracking table the World's own `bootstrap` command uses, so either can run later.
    await migrateFolder(database, folders.world, { table: "workflow_migrations", schema: "workflow_drizzle" });
    // graphile-worker installs its schema on first start, racily; do it here, under the lock.
    const worker = await makeWorkerUtils({ connectionString: urls.world });
    try {
      await worker.migrate();
    } finally {
      await worker.release();
    }
  });
  console.log(`Database is up to date (${Math.round(performance.now() - started)} ms).`);
}

/** Runs `task` holding a session advisory lock, on one connection, so the lock and the work share a session. */
async function withLock(url: string, lock: bigint, task: (database: Db) => Promise<void>): Promise<void> {
  const database = createDb(url, { max: 1 });
  try {
    await database.$client`select pg_advisory_lock(${lock.toString()}::bigint)`;
    await task(database);
  } finally {
    // Ending the session releases the lock.
    await database.$client.end();
  }
}

/** The World's migrations, in the installed package (src/drizzle/migrations is in its published files). */
function worldMigrationsDir(): string {
  const entry = createRequire(import.meta.url).resolve("@workflow/world-postgres");
  return join(dirname(entry), "..", "src", "drizzle", "migrations");
}

if (import.meta.main) {
  const { DATABASE_URL, DATABASE_MIGRATION_URL, WORKFLOW_POSTGRES_URL } = process.env;
  const app = DATABASE_MIGRATION_URL || DATABASE_URL;
  const world = WORKFLOW_POSTGRES_URL || DATABASE_URL;
  if (!app || !world) {
    console.error("Set DATABASE_URL to migrate the database.");
    process.exit(2);
  }
  const folders = { app: process.env.SANDCHEST_MIGRATIONS, world: process.env.SANDCHEST_WORLD_MIGRATIONS };
  try {
    await migrateAll({ app, world }, folders.app && folders.world ? { app: folders.app, world: folders.world } : undefined);
  } catch (error) {
    // The message only: driver errors can carry the connection string.
    console.error(`Migrating the database failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<database url>") : "unknown error"}`);
    process.exit(1);
  }
}
