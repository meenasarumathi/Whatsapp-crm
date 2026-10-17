// ============================================================
// Schema catalog — tables, columns, keys and functions of the public
// schema, read once from PostgreSQL. The query builder uses it to
//   * accept only real table / column names (identifiers are never
//     taken from user input unchecked),
//   * cast parameters to the right column type,
//   * resolve embedded relations (contact:contacts(id,name)) from the
//     foreign keys,
//   * call functions with named arguments.
// ============================================================

import { getPool } from "./pool";

export interface ColumnInfo {
  name: string;
  /** format_type(): 'uuid', 'text[]', 'timestamp with time zone', 'jsonb', ... */
  type: string;
  isJson: boolean;
  isArray: boolean;
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** Child columns are themselves unique → the relation is one-to-one. */
  unique: boolean;
}

export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  primaryKey: string[];
  uniqueSets: string[][];
}

export interface FunctionInfo {
  name: string;
  argNames: string[];
  argTypes: string[];
  returnsSet: boolean;
  returnType: string;
}

export interface Catalog {
  tables: Map<string, TableInfo>;
  fks: ForeignKey[];
  functions: Map<string, FunctionInfo>;
}

const g = globalThis as unknown as { __wacrmCatalog?: Promise<Catalog> };

export function resetCatalog(): void {
  g.__wacrmCatalog = undefined;
}

export function getCatalog(): Promise<Catalog> {
  if (!g.__wacrmCatalog) {
    g.__wacrmCatalog = load().catch((err) => {
      g.__wacrmCatalog = undefined;
      throw err;
    });
  }
  return g.__wacrmCatalog;
}

async function load(): Promise<Catalog> {
  const pool = getPool();

  const cols = await pool.query<{ t: string; c: string; fmt: string; typname: string }>(`
    SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS fmt, ty.typname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`);

  const cons = await pool.query<{ t: string; kind: string; name: string; cols: string[]; rt: string | null; rcols: string[] | null }>(`
    SELECT c.conrelid::regclass::text AS t, c.contype AS kind, c.conname AS name,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
      CASE WHEN c.contype = 'f' THEN c.confrelid::regclass::text END AS rt,
      CASE WHEN c.contype = 'f' THEN (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) END AS rcols
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p','u','f')`);

  const uidx = await pool.query<{ t: string; cols: string[] }>(`
    SELECT i.indrelid::regclass::text AS t,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n) AS cols
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL`);

  const fns = await pool.query<{ name: string; argnames: string[] | null; argtypes: string[]; retset: boolean; ret: string }>(`
    SELECT p.proname AS name, p.proargnames AS argnames,
      ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS argtypes,
      p.proretset AS retset, format_type(p.prorettype, NULL) AS ret
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'`);

  const tables = new Map<string, TableInfo>();
  for (const r of cols.rows) {
    let t = tables.get(r.t);
    if (!t) {
      t = { name: r.t, columns: new Map(), primaryKey: [], uniqueSets: [] };
      tables.set(r.t, t);
    }
    t.columns.set(r.c, {
      name: r.c,
      type: r.fmt,
      isJson: r.typname === "json" || r.typname === "jsonb",
      isArray: r.fmt.endsWith("[]"),
    });
  }
  const fks: ForeignKey[] = [];
  const stripSchema = (s: string) => s.replace(/^public\./, "").replace(/^"|"$/g, "");
  for (const c of cons.rows) {
    const t = tables.get(stripSchema(c.t));
    if (!t) continue;
    if (c.kind === "p") t.primaryKey = c.cols;
    if (c.kind === "u" || c.kind === "p") t.uniqueSets.push(c.cols);
    if (c.kind === "f" && c.rt && c.rcols) {
      fks.push({ name: c.name, table: t.name, columns: c.cols, refTable: stripSchema(c.rt), refColumns: c.rcols, unique: false });
    }
  }
  for (const u of uidx.rows) {
    const t = tables.get(stripSchema(u.t));
    if (t && u.cols) t.uniqueSets.push(u.cols);
  }
  for (const fk of fks) {
    const t = tables.get(fk.table)!;
    fk.unique = t.uniqueSets.some((s) => s.length === fk.columns.length && s.every((x) => fk.columns.includes(x)));
  }
  const functions = new Map<string, FunctionInfo>();
  for (const f of fns.rows) {
    functions.set(f.name, {
      name: f.name,
      argNames: f.argnames ?? [],
      argTypes: f.argtypes,
      returnsSet: f.retset,
      returnType: f.ret,
    });
  }
  return { tables, fks, functions };
}
