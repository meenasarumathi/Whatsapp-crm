// Applies db/schema.sql to DATABASE_URL.  Safe to run any number of times:
//   * every statement in the schema is idempotent (see db/schema.sql header),
//   * the whole run is ONE transaction - any error rolls everything back, nothing half-applied,
//   * an advisory lock stops two runs (e.g. two terminals) from racing,
//   * the applied schema's checksum is stored in public.schema_migrations; an unchanged schema is skipped.
// It never drops or truncates anything.
// Usage:  npm run db:init            (apply if new or changed)
//         npm run db:init -- --force (re-apply even if the checksum matches)
//         npm run db:init -- --replace-functions
//             (only if a stale function with a different return type has dependants: drops them
//              with CASCADE; the schema re-creates its own triggers/policies right afterwards)
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
const replaceFunctions = args.includes("--replace-functions");
const file = args.find((a) => !a.startsWith("--")) || join(root, "db", "schema.sql");
const VERSION = "schema.sql";

const sql = readFileSync(file, "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");

const client = new pg.Client({ connectionString: url });

// ---- statement splitter (understands comments, quotes and $tag$ bodies) -------------------------
function splitStatements(text) {
  const out = []; let start = 0, i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (text.startsWith("--", i)) { const j = text.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (text.startsWith("/*", i)) { const j = text.indexOf("*/", i); i = j < 0 ? n : j + 2; continue; }
    if (c === "'") { i++; while (i < n) { if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; } if (text[i] === "'") break; i++; } i++; continue; }
    if (c === '"') { const j = text.indexOf('"', i + 1); i = j < 0 ? n : j + 1; continue; }
    if (c === "$") { const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64)); if (m) { const j = text.indexOf(m[0], i + m[0].length); i = j < 0 ? n : j + m[0].length; continue; } }
    if (c === ";") { out.push(text.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out.filter((st) => st.replace(/--[^\n]*/g, "").trim() !== "");
}
const splitTop = (body) => { const parts = []; let d = 0, cur = "", q = false;
  for (const ch of body) { if (ch === "'") q = !q; if (!q) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; } } cur += ch; }
  if (cur.trim()) parts.push(cur); return parts; };

// "CREATE OR REPLACE FUNCTION public.f(a uuid, b account_role_enum DEFAULT 'x')" -> { schema, name, argTypes[] }
async function functionIdentity(stmt) {
  const m = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:("?[\w]+"?)\.)?("?[\w]+"?)\s*\(/i.exec(stmt);
  if (!m) return null;
  let i = m.index + m[0].length, d = 1, j = i;
  while (j < stmt.length && d > 0) { if (stmt[j] === "(") d++; if (stmt[j] === ")") d--; j++; }
  const argTypes = [];
  for (let part of splitTop(stmt.slice(i, j - 1))) {
    part = part.trim(); if (!part) continue;
    if (/^(OUT|INOUT)\b/i.test(part)) { if (/^OUT\b/i.test(part)) continue; }
    part = part.replace(/^(IN|INOUT|VARIADIC)\s+/i, "").replace(/\s+(DEFAULT\b|=).*$/is, "").trim();
    let t = (await client.query("select to_regtype($1) t", [part])).rows[0].t;
    if (!t) t = (await client.query("select to_regtype($1) t", [part.replace(/^\S+\s+/, "")])).rows[0].t;
    if (!t) return null;
    argTypes.push(t);
  }
  return { schema: (m[1] || "public").replace(/"/g, ""), name: m[2].replace(/"/g, ""), argTypes };
}

// Run one statement. A CREATE OR REPLACE FUNCTION that hits 42P13 (existing function has another
// return type) is retried after dropping exactly that function signature (see header for dependants).
async function run(stmt) {
  const isFn = /^\s*(?:--[^\n]*\n\s*)*CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(stmt);
  if (!isFn) { await client.query(stmt); return; }
  await client.query("SAVEPOINT stmt");
  try { await client.query(stmt); await client.query("RELEASE SAVEPOINT stmt"); return; }
  catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT stmt");
    if (e.code !== "42P13") throw e;
    const id = await functionIdentity(stmt);
    if (!id) throw e;
    const { rows } = await client.query(
      `select p.oid::regprocedure::text sig, pg_get_function_result(p.oid) result from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=$1 and p.proname=$2 and p.proargtypes::regtype[]::text[] = $3::text[]`, [id.schema, id.name, id.argTypes]);
    if (!rows.length) throw e;
    const { sig, result } = rows[0];
    console.log(`  replacing stale function ${sig} (it returned ${result}; the schema needs a different return type)`);
    await client.query("SAVEPOINT drop_fn");
    try { await client.query(`DROP FUNCTION ${sig}`); await client.query("RELEASE SAVEPOINT drop_fn"); }
    catch (de) {
      await client.query("ROLLBACK TO SAVEPOINT drop_fn");
      if (de.code !== "2BP01" || !replaceFunctions) {
        de.message = `${de.message}\n  ${String(de.detail || "").replace(/\n/g, "\n  ")}\n  Re-run with  npm run db:init -- --replace-functions  to drop those dependants too (this schema re-creates its own).`;
        throw de;
      }
      await client.query(`DROP FUNCTION ${sig} CASCADE`);
    }
    await client.query(stmt);
  }
}

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
    for (const st of splitStatements(sql)) {
      try { await run(st); }
      catch (e) { e.statement = st.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().slice(0, 160); throw e; }
    }
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
  if (e.statement) console.error("  statement:", e.statement);
  if (e.detail) console.error("  detail:", e.detail);
  if (e.hint) console.error("  hint:", e.hint);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
