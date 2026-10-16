// Applies db/schema.sql to DATABASE_URL (idempotent on a fresh DB; use on databases that were
// not initialised by docker-entrypoint-initdb.d).  Usage: npm run db:init
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm";
const file = process.argv[2] || join(root, "db", "schema.sql");
const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query("SELECT to_regclass('public.users') AS u");
if (rows[0].u && !process.argv.includes("--force")) {
  console.log("Schema already present (public.users exists) - nothing to do. Use --force to re-apply.");
} else {
  await client.query(readFileSync(file, "utf8"));
  console.log("Applied", file);
}
await client.end();
