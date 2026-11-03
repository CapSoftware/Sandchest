/**
 * The database handles, on their own so the dashboard's pages load only the
 * database client: not the engine, GitHub App or workflow runtime that
 * `services` brings in for scans.
 *
 * - `db()`: the primary, directly. Everything people wait on: about a
 *   millisecond faster per query than going through a pooler.
 * - `analyticsDb()`: analytics writes, through the pooler when there is one,
 *   one connection per instance that closes when idle. Writes run after the
 *   response and give way under load (see `recordEvents`).
 * - `replicaDb()`: the operator dashboards' aggregates, on a read replica
 *   when there is one.
 */
import { createDb, type Db } from "@sandchest/db";
import { config } from "./config";

let instance: Db | undefined;
let analytics: Db | undefined;
let replica: Db | undefined;

export function db(): Db {
  return (instance ??= createDb(config().DATABASE_URL, { applicationName: "sandchest" }));
}

export function analyticsDb(): Db {
  const settings = config();
  return (analytics ??= createDb(settings.DATABASE_POOLER_URL ?? settings.DATABASE_URL, {
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
