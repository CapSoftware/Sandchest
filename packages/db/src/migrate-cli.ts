/**
 * `bun run migrate`: applies pending migrations. Uses DATABASE_MIGRATION_URL
 * when set (a role allowed to change the schema), else DATABASE_URL.
 */
import { createDb } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_MIGRATION_URL or DATABASE_URL");
  process.exit(2);
}
const database = createDb(url, { max: 1 });
await migrate(database);
await database.$client.end();
console.log("Migrations applied.");
