// Applies db/schema.sql to DATABASE_URL.  Safe to run any number of times:
//   * every statement in the schema is idempotent (see db/schema.sql header),
//   * the whole run is ONE transaction - any error rolls everything back, nothing half-applied,
//   * an advisory lock stops two runs (e.g. two terminals) from racing,
//   * the applied schema's checksum is stored in public.schema_migrations; an unchanged schema is skipped.
// It never drops or truncates anything.
// Usage:  npm run db:init            (apply if new or changed)
//         npm run db:init -- --force (re-apply even if the checksum matches)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Pick up DATABASE_URL from .env.local / .env like the app does (real environment variables win).
for (const f of [".env.local", ".env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch {} }
const stripSchema = (u) => u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = stripSchema(process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm");
const args = process.argv.slice(2);
const force = args.includes("--force");
const file = args.find((a) => !a.startsWith("--")) || join(root, "db", "schema.sql");
const VERSION = "schema.sql";

const sql = readFileSync(file, "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");

const client = new pg.Client({ connectionString: url });
client.on("notice", (n) => { if (/already|skipping/i.test(n.message)) return; console.log("  notice:", n.message); });
try {
  await client.connect();
} catch (e) {
  console.error(`Cannot connect: ${e.code || ""} ${e.message}\nRun "npm run db:test" for a diagnosis.`);
  process.exit(1);
}

const tables = async () => new Set((await client.query(
  "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows.map((r) => r.table_name));

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wacrm_db_init'))");
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  // bookkeeping only - the application role must not see it
  await client.query("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wacrm_app') THEN REVOKE ALL ON public.schema_migrations FROM wacrm_app; END IF; END $$");
  const prev = (await client.query("SELECT checksum, applied_at FROM public.schema_migrations WHERE version=$1", [VERSION])).rows[0];
  const before = await tables();
  before.delete("schema_migrations");

  if (prev && prev.checksum === checksum && !force) {
    await client.query("COMMIT");
    console.log(`Schema already up to date (applied ${prev.applied_at.toISOString()}, ${before.size} tables). Nothing to do. Use --force to re-apply.`);
  } else {
    await client.query(sql);
    await client.query(
      `INSERT INTO public.schema_migrations (version, checksum) VALUES ($1,$2)
       ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`, [VERSION, checksum]);
    const after = await tables();
    after.delete("schema_migrations");
    await client.query("COMMIT");
    const created = [...after].filter((t) => !before.has(t)).sort();
    console.log(`Applied ${file}`);
    console.log(`  tables: ${after.size} total, ${created.length} created, ${before.size} already existed (kept, data untouched)`);
    if (before.size && created.length) console.log(`  created: ${created.join(", ")}`);
    if (before.size && !created.length) console.log("  (re-applied over an existing schema: only missing objects/columns were added)");
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nSchema NOT applied - the transaction was rolled back, the database is unchanged.\n  ${e.code || ""} ${e.message}`);
  if (e.where) console.error("  where:", String(e.where).split("\n")[0]);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
