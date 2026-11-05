/**
 * `bun run check:migrations`: fails when the database this checkout deploys
 * against is missing a migration in this checkout. A deploy never migrates,
 * so code that reads a new table or column must not ship before its
 * migration: the pre-push hook runs this first. Read-only.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { migrationsDir } from "./migrate";

const url = process.env.DATABASE_URL || process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.log("check:migrations: no DATABASE_URL, skipped");
  process.exit(0);
}
const journal = JSON.parse(readFileSync(`${migrationsDir()}/meta/_journal.json`, "utf8")) as { entries: Array<{ tag: string; when: number }> };
const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
try {
  const [row] = await sql.begin("read only", (tx) => tx`select coalesce(max(created_at), 0)::bigint as last from drizzle.__drizzle_migrations`);
  const last = Number(row?.last ?? 0);
  // Drizzle applies every migration newer than the last one it recorded.
  const pending = journal.entries.filter((entry) => entry.when > last).map((entry) => entry.tag);
  if (pending.length > 0) {
    console.error(`check:migrations: the database is missing ${pending.join(", ")}. Apply them first (bun run migrate in packages/db), then push.`);
    process.exit(1);
  }
  console.log(`check:migrations: up to date (${journal.entries.length} migrations)`);
} finally {
  await sql.end();
}
