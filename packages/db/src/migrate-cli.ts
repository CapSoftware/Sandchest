/** `bun run migrate`: applies pending migrations to DATABASE_URL. */
import { createDb } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const database = createDb(url, { max: 1 });
await migrate(database);
await database.$client.end();
console.log("Migrations applied.");
