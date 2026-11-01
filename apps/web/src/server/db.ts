/**
 * The database handle, on its own so the dashboard's pages load only the
 * database client: not the engine, GitHub App or workflow runtime that
 * `services` brings in for scans.
 */
import { createDb, type Db } from "@sandchest/db";
import { config } from "./config";

let instance: Db | undefined;

export function db(): Db {
  return (instance ??= createDb(config().DATABASE_URL));
}

/** For tests. */
export function setDb(database: Db): void {
  instance = database;
}
