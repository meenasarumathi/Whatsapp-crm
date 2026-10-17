// Brings DATABASE_URL to the schema in db/schema.sql - safely, and any number of times.
//
//   npm run db:init                       apply / repair
//   npm run db:init -- --plan             do everything, print what would change, then ROLL BACK
//   npm run db:init -- --force            re-apply even if the recorded checksum matches
//   npm run db:init -- --replace-functions  also drop objects that depend on a stale function (CASCADE)
//
// What it does, all inside ONE transaction (any error => full rollback, database unchanged):
//   1. reads the live catalog and compares it with db/schema-reference.json (tables, columns, types,
//      defaults, nullability, constraints, indexes, enums, function return types);
//   2. repairs what is incompatible: drops old policies and mismatching/foreign-schema foreign keys
//      (they are re-created from the schema), converts columns whose type differs (USING a cast - fails and
//      rolls back if existing values cannot be converted);
//   3. runs db/schema.sql statement by statement (idempotent; a function whose return type changed is
//      dropped and re-created);
//   4. adds whatever constraints / indexes / defaults / NOT NULLs are still missing;
//   5. re-compares the catalog - it must report ZERO differences or the whole run is rolled back;
//   6. records the schema checksum in public.schema_migrations.
// It never drops or truncates tables, never deletes rows, never drops the database or an enum type.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { blocking, countProblems, diffCatalog, readCatalog } from "./lib/catalog.mjs";

// Pick up DATABASE_URL from .env.local / .env like the app does (real environment variables win).
for (const f of [".env.local", ".env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch {} }
const stripSchema = (u) => u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = stripSchema(process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm");
const args = process.argv.slice(2);
const force = args.includes("--force");
const plan = args.includes("--plan");
const replaceFunctions = args.includes("--replace-functions");
const file = args.find((a) => !a.startsWith("--")) || join(root, "db", "schema.sql");
const refFile = join(root, "db", "schema-reference.json");
const VERSION = "schema.sql";

const sql = readFileSync(file, "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");
const ref = existsSync(refFile) ? JSON.parse(readFileSync(refFile, "utf8")) : null;
if (!ref) console.warn("  (db/schema-reference.json not found: running without the compatibility check)");

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const actions = [];
const act = (kind, text) => actions.push({ kind, text });

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

const client = new pg.Client({ connectionString: url });
client.on("notice", (n) => { if (/already|skipping|does not exist/i.test(n.message)) return; console.log("  notice:", n.message); });

// Run a statement inside a savepoint so a failure can be handled and the transaction stays usable.
async function sp(name, stmt, params) {
  await client.query(`SAVEPOINT ${name}`);
  try { const r = await client.query(stmt, params); await client.query(`RELEASE SAVEPOINT ${name}`); return r; }
  catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
}

// One schema statement.  Postgres cannot CREATE OR REPLACE a function whose return type changed (42P13): it tells us
// the exact signature in the hint; drop that one function (no CASCADE unless --replace-functions) and retry.
async function runStatement(stmt) {
  if (!/CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(stmt)) { await client.query(stmt); return; }
  for (let attempt = 0; attempt < 25; attempt++) {
    try { await sp("stmt", stmt); return; }
    catch (e) {
      const m = e.code === "42P13" && /DROP FUNCTION\s+(.+?)\s+first/i.exec(e.hint || "");
      if (!m) throw e;
      const sig = m[1];
      try { await sp("dropfn", `DROP FUNCTION ${sig}`); act("function", `replaced stale function ${sig} (different return type)`); }
      catch (de) {
        if (de.code !== "2BP01" || !replaceFunctions) {
          de.message = `${de.message}\n  ${String(de.detail || "").replace(/\n/g, "\n  ")}\n  Re-run with  npm run db:init -- --replace-functions  to drop those dependants too (this schema re-creates its own).`;
          throw de;
        }
        await client.query(`DROP FUNCTION ${sig} CASCADE`);
        act("function", `replaced stale function ${sig} with CASCADE (--replace-functions)`);
      }
    }
  }
  throw new Error("too many stale functions in one statement");
}


// An earlier Supabase-style install keeps its users in auth.users and points foreign keys there.  The new foreign
// keys point at public.users, so carry the accounts over (same ids, emails, password hashes) before they are added.
// The signup triggers are switched off for the copy: the accounts/profiles of these users already exist.
async function importLegacyAuthUsers() {
  if (!(await client.query("select to_regclass('auth.users') a")).rows[0].a) return;
  const cols = (await client.query(`select a.column_name from information_schema.columns a
      join information_schema.columns b on b.column_name = a.column_name and b.table_schema='public' and b.table_name='users'
      where a.table_schema='auth' and a.table_name='users'`)).rows.map((r) => r.column_name);
  const hasHash = (await client.query("select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='encrypted_password'")).rowCount > 0;
  const target = [...cols, ...(hasHash ? ["password_hash"] : [])];
  const source = [...cols.map((c) => `a.${q(c)}`), ...(hasHash ? ["a.encrypted_password"] : [])];
  if (!cols.includes("id") || !cols.includes("email")) return;
  await client.query("ALTER TABLE public.users DISABLE TRIGGER USER");
  const r = await client.query(`INSERT INTO public.users (${target.map(q).join(",")})
      SELECT ${source.join(",")} FROM auth.users a WHERE a.email IS NOT NULL
      ON CONFLICT DO NOTHING`);
  await client.query("ALTER TABLE public.users ENABLE TRIGGER USER");
  if (r.rowCount) act("data", `copied ${r.rowCount} user(s) from auth.users into public.users (ids, emails, password hashes kept)`);
}

// ---- compatibility repair of objects that already exist ---------------------------------------
async function preRepair(d, live) {
  const refTables = Object.keys(ref.tables).filter((t) => live.tables[t]);
  // old policies (e.g. written for auth.uid()) are replaced by the ones in the schema
  const pol = (await client.query(
    "select schemaname, tablename, policyname from pg_policies where schemaname='public' and tablename = any($1)", [refTables])).rows;
  for (const p of pol) await client.query(`DROP POLICY IF EXISTS ${q(p.policyname)} ON public.${q(p.tablename)}`);
  if (pol.length) act("policy", `dropped ${pol.length} existing policies on application tables (re-created from the schema)`);

  const needFkDrop = d.constraintDiffs.length || d.typeDiffs.length || d.foreignSchemaFks.length;
  if (needFkDrop) {
    const fks = Object.values(live.constraints).filter((c) => c.kind === "f" && ref.tables[c.table]);
    for (const c of fks) await client.query(`ALTER TABLE public.${q(c.table)} DROP CONSTRAINT ${q(c.name)}`);
    act("constraint", `dropped ${fks.length} foreign keys to re-create them (${d.foreignSchemaFks.length} pointed outside the public schema, e.g. auth.users)`);
  }
  for (const c of d.constraintDiffs.filter((c) => c.kind !== "f")) {
    await client.query(`ALTER TABLE public.${q(c.table)} DROP CONSTRAINT ${q(c.name)}`);
    act("constraint", `dropped differing ${c.table}.${c.name}: was ${c.liveDef}`);
  }
  for (const t of d.typeDiffs) {
    const col = `public.${q(t.table)}`;
    await client.query(`ALTER TABLE ${col} ALTER COLUMN ${q(t.column)} DROP DEFAULT`);
    try { await sp("coltype", `ALTER TABLE ${col} ALTER COLUMN ${q(t.column)} TYPE ${t.to} USING ${q(t.column)}::${t.to}`); }
    catch (e) { e.message = `cannot convert ${t.table}.${t.column} from ${t.from} to ${t.to}: ${e.message}`; throw e; }
    act("column", `converted ${t.table}.${t.column}: ${t.from} -> ${t.to}`);
  }
}

// Adds missing / differing constraints.  Primary keys, unique and check constraints must exist before any
// foreign key that references them, so this runs once for those kinds (before the schema adds its foreign
// keys) and once more for everything that is still missing.
async function addConstraints(kinds) {
  const live = await readCatalog(client);
  const d = diffCatalog(ref, live);
  const order = { p: 0, u: 1, c: 2, x: 3, f: 4 };
  for (const c of [...d.missingConstraints, ...d.constraintDiffs].filter((c) => kinds.includes(c.kind)).sort((a, b) => order[a.kind] - order[b.kind])) {
    if (c.liveDef) await client.query(`ALTER TABLE public.${q(c.table)} DROP CONSTRAINT ${q(c.name)}`);
    try { await sp("addcon", `ALTER TABLE public.${q(c.table)} ADD CONSTRAINT ${q(c.name)} ${c.def}`); }
    catch (e) { e.message = `cannot add ${c.table}.${c.name} (${c.def}): ${e.message} - existing rows may violate it`; throw e; }
    act("constraint", `added ${c.table}.${c.name}`);
  }
}

async function postRepair() {
  await addConstraints(["p", "u", "c", "x", "f"]);
  const live = await readCatalog(client);
  const d = diffCatalog(ref, live);
  for (const i of d.indexDiffs) { await client.query(`DROP INDEX public.${q(i.name)}`); await client.query(i.def); act("index", `re-created index ${i.name}`); }
  for (const i of d.missingIndexes) { await client.query(i.def); act("index", `created index ${i.name}`); }
  for (const n of d.defaultDiffs) {
    await client.query(`ALTER TABLE public.${q(n.table)} ALTER COLUMN ${q(n.column)} ${n.to == null ? "DROP DEFAULT" : "SET DEFAULT " + n.to}`);
    act("column", `default of ${n.table}.${n.column}: ${n.from ?? "none"} -> ${n.to ?? "none"}`);
  }
  for (const f of d.functionAclDiffs) {
    await client.query(`${f.to ? "GRANT EXECUTE ON FUNCTION " + f.sig + " TO PUBLIC" : "REVOKE ALL ON FUNCTION " + f.sig + " FROM PUBLIC"}`);
    act("function", `execute right of ${f.sig}: ${f.to ? "granted to" : "revoked from"} PUBLIC`);
  }
  for (const n of d.nullDiffs) {
    try { await sp("nn", `ALTER TABLE public.${q(n.table)} ALTER COLUMN ${q(n.column)} ${n.to ? "SET NOT NULL" : "DROP NOT NULL"}`); }
    catch (e) { e.message = `cannot set NOT NULL on ${n.table}.${n.column}: ${e.message} - the column contains NULL values`; throw e; }
    act("column", `${n.table}.${n.column}: ${n.to ? "SET NOT NULL" : "DROP NOT NULL"}`);
  }
}

function describe(d) {
  const lines = [];
  const add = (label, arr, fmt) => { if (arr.length) lines.push(`  ${label}: ${arr.length}${arr.length <= 6 ? " - " + arr.map(fmt).join("; ") : ""}`); };
  add("tables to create", d.missingTables, (x) => x);
  add("columns to add", d.missingColumns, (x) => `${x.table}.${x.column}`);
  add("column types to convert", d.typeDiffs, (x) => `${x.table}.${x.column} ${x.from}->${x.to}`);
  add("NOT NULL differences", d.nullDiffs, (x) => `${x.table}.${x.column}`);
  add("default differences", d.defaultDiffs, (x) => `${x.table}.${x.column}`);
  add("constraints to add", d.missingConstraints, (x) => `${x.table}.${x.name}`);
  add("constraints that differ", d.constraintDiffs, (x) => `${x.table}.${x.name}`);
  add("foreign keys pointing outside public", d.foreignSchemaFks, (x) => `${x.table}.${x.name}->${x.refschema}`);
  add("indexes to add", d.missingIndexes, (x) => x.name);
  add("indexes that differ", d.indexDiffs, (x) => x.name);
  add("functions with another return type", d.functionDiffs, (x) => `${x.sig}: ${x.from}->${x.to}`);
  add("functions with other execute rights", d.functionAclDiffs, (x) => x.sig);
  add("enums lacking values", d.enumProblems, (x) => `${x.name}: ${x.missing}`);
  return lines;
}

// ---- main -----------------------------------------------------------------------------------
try { await client.connect(); }
catch (e) { console.error(`Cannot connect: ${e.code || ""} ${e.message}\nRun "npm run db:test" for a diagnosis.`); process.exit(1); }

let exitCode = 0;
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wacrm_db_init'))");
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wacrm_app') THEN REVOKE ALL ON public.schema_migrations FROM wacrm_app; END IF; END $$");
  const prev = (await client.query("SELECT checksum, applied_at FROM public.schema_migrations WHERE version=$1", [VERSION])).rows[0];

  const live0 = await readCatalog(client);
  const d0 = ref ? diffCatalog(ref, live0) : null;
  const existing = Object.keys(live0.tables).length;
  const problems0 = d0 ? countProblems(d0) : 0;
  if (d0 && existing) {
    console.log(`Found ${existing} existing table(s) in public. Comparison with the expected schema:`);
    const lines = describe(d0);
    console.log(lines.length ? lines.join("\n") : "  no differences");
    if (d0.extraTables.length) console.log(`  other tables (left untouched): ${d0.extraTables.join(", ")}`);
  }

  if (prev && prev.checksum === checksum && !force && !plan && problems0 === 0) {
    await client.query("COMMIT");
    console.log(`Schema already up to date (applied ${prev.applied_at.toISOString()}, ${existing} tables). Nothing to do. Use --force to re-apply.`);
  } else {
    if (d0 && d0.enumProblems.length) {
      const e = d0.enumProblems[0];
      throw Object.assign(new Error(`enum ${e.name} exists but lacks value(s) ${e.missing.join(", ")}; add them (ALTER TYPE ${e.name} ADD VALUE '...') and re-run`), { code: "ENUM" });
    }
    if (d0 && existing) await preRepair(d0, live0);
    const stmts = splitStatements(sql);
    let usersCopied = false;
    for (const st of stmts) {
      try {
        // all tables exist by the time the first foreign key is added
        if (!usersCopied && /^\s*(?:--[^\n]*\n\s*)*DO \$con\$/.test(st)) { usersCopied = true; await importLegacyAuthUsers(); if (ref) await addConstraints(["p", "u", "c", "x"]); }
        await runStatement(st);
      }
      catch (e) { e.statement = st.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().slice(0, 200); throw e; }
    }
    if (ref) {
      await postRepair();
      const live2 = await readCatalog(client);
      const d2 = diffCatalog(ref, live2);
      const left = countProblems(d2);
      if (left) {
        const b = blocking(d2);
        throw Object.assign(new Error(`after repair the database still differs from the schema:\n  ${describe(d2).join("\n  ")}\n  ${JSON.stringify(Object.fromEntries(Object.entries(b).filter(([, v]) => v.length)), null, 0).slice(0, 600)}`), { code: "VERIFY" });
      }
    }
    await client.query(
      `INSERT INTO public.schema_migrations (version, checksum) VALUES ($1,$2)
       ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`, [VERSION, checksum]);
    const tableCount = (await client.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name<>'schema_migrations'")).rows[0].n;

    const byKind = {};
    for (const a of actions) (byKind[a.kind] ??= []).push(a.text);
    if (actions.length) {
      console.log("Repairs made:");
      for (const [k, v] of Object.entries(byKind)) { for (const t of v.slice(0, 40)) console.log(`  - ${t}`); if (v.length > 40) console.log(`  - ... and ${v.length - 40} more ${k} changes`); }
    }
    if (plan) {
      await client.query("ROLLBACK");
      console.log(`\nPLAN ONLY: all steps succeeded (would end with ${tableCount} tables, 0 differences). Nothing was changed. Run without --plan to apply.`);
    } else {
      await client.query("COMMIT");
      const created = d0 ? d0.missingTables.length : tableCount;
      console.log(`\nApplied ${file}\n  tables: ${tableCount} total, ${created} created, ${tableCount - created} already existed (kept, rows untouched)\n  verified: database matches the schema (0 differences)`);
    }
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  exitCode = 1;
  console.error(`\nSchema NOT applied - the transaction was rolled back, the database is unchanged.\n  ${e.code || ""} ${e.message}`);
  if (e.statement) console.error("  statement:", e.statement);
  if (e.detail && !String(e.message).includes(e.detail)) console.error("  detail:", e.detail);
  if (e.hint) console.error("  hint:", e.hint);
} finally {
  await client.end().catch(() => {});
}
process.exit(exitCode);
