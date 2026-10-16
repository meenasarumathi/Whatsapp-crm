// ============================================================================
// Validate the migrated data in the NEW PostgreSQL against the export manifest:
//   * row counts per table
//   * order-independent content checksum per table (every value, exactly as exported)
//   * every foreign key resolves (no orphans), no unvalidated constraints
//   * every uploaded file referenced by the data exists on disk (--uploads <dir>)
//
//   DATABASE_URL=postgresql://postgres:strong_password@localhost:5433/wacrm \
//   node validate.mjs [--manifest export/manifest.json] [--uploads export/uploads]
// ============================================================================
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_SETUP, TableHash, connectionOptions, q, target } from "./common.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const manifestPath = opt("--manifest", "export/manifest.json");
const uploadsDir = opt("--uploads", null);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const url = process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm";

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`); };

const c = new pg.Client(connectionOptions(url));
await c.connect();
for (const s of SESSION_SETUP) await c.query(s);

console.log("== row counts and content checksums");
for (const [table, m] of Object.entries(manifest.tables)) {
  if (m.sourceRows === null) continue;
  const cols = m.columns;
  const n = Number((await c.query(`SELECT count(*) AS n FROM public.${q(table)}`)).rows[0].n);
  const hash = new TableHash();
  const cur = `v_${table}`;
  await c.query("BEGIN");
  await c.query(`DECLARE ${cur} NO SCROLL CURSOR FOR SELECT ${cols.map((x) => `${q(x)}::text AS ${q(x)}`).join(", ")} FROM public.${q(table)}`);
  for (;;) {
    const { rows } = await c.query(`FETCH 2000 FROM ${cur}`);
    if (!rows.length) break;
    for (const r of rows) hash.add(cols.map((x) => r[x]));
  }
  await c.query("COMMIT");
  check(`${table}: ${m.exportedRows} rows`, n === m.exportedRows, `target has ${n}`);
  check(`${table}: content checksum`, hash.hex() === m.checksum, "values differ from the export");
}

console.log("\n== foreign keys");
for (const [table, def] of Object.entries(target.tables)) {
  if (!manifest.tables[table] || manifest.tables[table].sourceRows === null) continue;
  for (const fk of def.fks) {
    const on = fk.columns.map((col, i) => `c.${q(col)} = p.${q(fk.refColumns[i])}`).join(" AND ");
    const nn = fk.columns.map((col) => `c.${q(col)} IS NOT NULL`).join(" AND ");
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.${q(table)} c LEFT JOIN public.${q(fk.refTable)} p ON ${on} WHERE ${nn} AND p.${q(fk.refColumns[0])} IS NULL`);
    check(`${table}.${fk.columns.join(",")} -> ${fk.refTable}`, rows[0].n === 0, `${rows[0].n} orphan rows`);
  }
}
const nv = await c.query("SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace");
check("all constraints validated", nv.rows.length === 0, JSON.stringify(nv.rows));

console.log("\n== accounts and users");
const noProfile = await c.query("SELECT count(*)::int AS n FROM public.users u LEFT JOIN public.profiles p ON p.user_id = u.id WHERE p.user_id IS NULL");
check("every user has a profile", noProfile.rows[0].n === 0, `${noProfile.rows[0].n} users without profile`);
const noHash = await c.query("SELECT count(*)::int AS n FROM public.users WHERE password_hash IS NULL OR password_hash = ''");
check("every user can sign in (has a password hash)", noHash.rows[0].n === 0, `${noHash.rows[0].n} users have no password`);

if (uploadsDir) {
  console.log("\n== uploaded files referenced by the data");
  const refs = new Set();
  const scans = [["messages", "media_url"], ["profiles", "avatar_url"], ["quick_replies", "interactive_payload::text"], ["flow_nodes", "config::text"], ["messages", "interactive_payload::text"]];
  for (const [t, expr] of scans) {
    if (!target.tables[t]) continue;
    const { rows } = await c.query(`SELECT ${expr} AS v FROM public.${q(t)} WHERE ${expr} LIKE '%/api/files/%'`).catch(() => ({ rows: [] }));
    for (const r of rows) for (const m of r.v.matchAll(/\/api\/files\/([A-Za-z0-9_-]+)\/([^"'\s?#)\\]+)/g)) refs.add(`${m[1]}/${decodeURIComponent(m[2])}`);
  }
  const missing = [...refs].filter((r) => !existsSync(join(uploadsDir, ...r.split("/"))));
  check(`${refs.size} referenced files present in ${uploadsDir}`, missing.length === 0, `${missing.length} missing, e.g. ${missing.slice(0, 3).join(", ")}`);
}
await c.end();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
