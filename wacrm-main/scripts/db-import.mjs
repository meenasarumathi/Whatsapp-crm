// Loads an exported data file (wacrm_data.sql from migration/export.mjs) into DATABASE_URL.
// Usage: npm run db:import -- path/to/wacrm_data.sql
import { readFileSync } from "node:fs";
import pg from "pg";
import { existsSync } from "node:fs";
// Pick up DATABASE_URL from .env.local / .env like the app does (real environment variables win).
for (const f of [".env.local", ".env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch {} }
const stripSchema = (u) => u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");

const file = process.argv[2];
if (!file) { console.error("usage: db-import.mjs <wacrm_data.sql>"); process.exit(1); }
const url = stripSchema(process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(readFileSync(file, "utf8")); // file wraps itself in BEGIN/COMMIT
  console.log("Imported", file);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Import failed, rolled back:", e.message);
  process.exitCode = 1;
}
await client.end();
