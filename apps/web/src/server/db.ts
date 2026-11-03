/**
 * The database handles, on their own so the dashboard's pages load only the
 * database client: not the engine, GitHub App or workflow runtime that
 * `services` brings in for scans.
 *
 * - `db()`: everything the app does, through the pooler when there is one
 *   (`DATABASE_POOLER_URL`). Each server instance keeps a few connections to
 *   the pooler, which lends out the database's own connections one
 *   transaction at a time, so the database's connection count stays fixed
 *   however many instances run, and an instance Vercel suspends holds none.
 *   About a millisecond more per query than a direct connection.
 * - `analyticsDb()`: analytics writes, the same way on a connection of their
 *   own, so they never queue behind the app. Writes run after the response
 *   and give way under load (see `recordEvents`).
 * - `replicaDb()`: the operator dashboards' aggregates, on a read replica
 *   when there is one.
 */
import { createDb, type Db } from "@sandchest/db";
import { config } from "./config";

let instance: Db | undefined;
let analytics: Db | undefined;
let replica: Db | undefined;

/** The URL the app's queries use: the pooler when there is one. Migrations and the workflow World use their own. */
export function appDatabaseUrl(): string {
  const settings = config();
  return settings.DATABASE_POOLER_URL ?? settings.DATABASE_URL;
}

/** Pages run at most four queries at once; more connections per instance would only crowd the pooler. */
const APP_POOL_SIZE = 4;

export function db(): Db {
  return (instance ??= createDb(appDatabaseUrl(), { max: APP_POOL_SIZE, applicationName: "sandchest" }));
}

export function analyticsDb(): Db {
  return (analytics ??= createDb(appDatabaseUrl(), {
    max: 1,
    idleTimeout: 5,
    connectTimeout: 5,
    applicationName: "sandchest-analytics",
  }));
}

export function replicaDb(): Db {
  const settings = config();
  if (!settings.DATABASE_REPLICA_URL) return db();
  return (replica ??= createDb(settings.DATABASE_REPLICA_URL, { max: 3, applicationName: "sandchest-ops" }));
}

/** For tests: every handle uses this database. */
export function setDb(database: Db): void {
  instance = database;
  analytics = database;
  replica = database;
}
