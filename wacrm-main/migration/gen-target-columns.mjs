// Describes the NEW schema (tables, columns, keys, foreign keys, load order) from a database
// that has db/schema.sql applied. Output: target-columns.json (checked in; regenerate after
// schema changes).   DATABASE_URL=... node gen-target-columns.mjs
import { writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm";
const c = new pg.Client({ connectionString: url });
await c.connect();

const cols = await c.query(`
  SELECT c.relname AS t, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, a.atthasdef AS hasdefault, a.attgenerated <> '' AS generated, a.attnum
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum`);
const cons = await c.query(`
  SELECT c.conrelid::regclass::text AS t, c.contype AS kind, c.conname AS name,
    (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
    CASE WHEN c.contype='f' THEN c.confrelid::regclass::text END AS rt,
    CASE WHEN c.contype='f' THEN (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) END AS rcols
  FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p','f')`);

const tables = {};
for (const r of cols.rows) (tables[r.t] ??= { columns: [], pk: [], fks: [] }).columns.push({ name: r.name, type: r.type, notnull: r.notnull, hasDefault: r.hasdefault, generated: r.generated });
const strip = (s) => s.replace(/^public\./, "").replace(/"/g, "");
for (const r of cons.rows) {
  const t = tables[strip(r.t)];
  if (!t) continue;
  if (r.kind === "p") t.pk = r.cols;
  else t.fks.push({ name: r.name, columns: r.cols, refTable: strip(r.rt), refColumns: r.rcols });
}
// Load order: parents before children (Kahn); cycles fall to the end alphabetically.
const names = Object.keys(tables).sort();
const deps = new Map(names.map((n) => [n, new Set(tables[n].fks.map((f) => f.refTable).filter((x) => x !== n && tables[x]))]));
const order = [];
const left = new Set(names);
while (left.size) {
  const ready = [...left].filter((n) => [...deps.get(n)].every((d) => !left.has(d))).sort();
  if (!ready.length) { order.push(...[...left].sort()); break; }
  for (const n of ready) { order.push(n); left.delete(n); }
}
writeFileSync(new URL("./target-columns.json", import.meta.url), JSON.stringify({ order, tables }, null, 1));
console.log(`target-columns.json: ${order.length} tables`);
await c.end();
