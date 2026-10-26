// Reads a normalised description of the application's database objects from pg_catalog, and diffs two
// descriptions.  Used by db-init (plan / repair / post-condition check) and db-reference (to generate
// db/schema-reference.json from a database that was built from a clean db/schema.sql).
const IGNORE_TABLES = new Set(["schema_migrations"]);
const VECTOR_DEPENDENT = /^match_ai_knowledge_semantic\(/;

export async function readCatalog(c) {
  await c.query("SET search_path TO public");
  const q = async (sql) => (await c.query(sql)).rows;
  const cat = { enums: {}, tables: {}, constraints: {}, indexes: {}, functions: {} };

  for (const r of await q(`select t.typname name, array_agg(e.enumlabel::text order by e.enumsortorder) labels
      from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' group by t.typname`)) cat.enums[r.name] = r.labels;

  for (const r of await q(`select c.relname t, a.attname col, a.attnum num, format_type(a.atttypid,a.atttypmod) type,
        a.attnotnull nn, pg_get_expr(d.adbin,d.adrelid) def, a.attgenerated gen
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped order by c.relname, a.attnum`)) {
    if (IGNORE_TABLES.has(r.t)) continue;
    (cat.tables[r.t] ??= {})[r.col] = { type: r.type, notnull: r.nn, default: r.gen ? null : r.def, generated: !!r.gen };
  }

  for (const r of await q(`select c.relname t, con.conname name, con.contype kind, pg_get_constraintdef(con.oid) def,
        (select nspname from pg_namespace where oid=(select relnamespace from pg_class where oid=con.confrelid)) refschema
      from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and con.contype in ('p','u','c','f','x')`)) {
    if (IGNORE_TABLES.has(r.t)) continue;
    cat.constraints[`${r.t}.${r.name}`] = { table: r.t, name: r.name, kind: r.kind, def: r.def, refschema: r.refschema };
  }

  for (const r of await q(`select c.relname t, i.relname name, pg_get_indexdef(i.oid) def
      from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class c on c.oid=x.indrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not exists (select 1 from pg_constraint k where k.conindid=i.oid)`)) {
    if (IGNORE_TABLES.has(r.t)) continue;
    cat.indexes[r.name] = { table: r.t, def: r.def };
  }

  for (const r of await q(`select p.proname name, pg_get_function_identity_arguments(p.oid) args,
        pg_get_function_result(p.oid) result, p.oid::regprocedure::text sig,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_exec
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')
        and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')`))
    cat.functions[r.sig] = { result: r.result, publicExec: r.public_exec };
  return cat;
}

// What `live` needs so that it matches `ref`.  Objects only present in `live` are reported separately
// (`extra`) and never touched, except foreign keys pointing outside the public schema (see fixes below).
export function diffCatalog(ref, live) {
  const d = { missingTables: [], missingColumns: [], typeDiffs: [], nullDiffs: [], defaultDiffs: [],
    missingConstraints: [], constraintDiffs: [], foreignSchemaFks: [], missingIndexes: [], indexDiffs: [],
    enumProblems: [], functionDiffs: [], functionAclDiffs: [], extraTables: [], extraFunctions: 0 };
  for (const [name, labels] of Object.entries(ref.enums)) {
    if (!live.enums[name]) continue; // created by the schema
    const missing = labels.filter((l) => !live.enums[name].includes(l));
    if (missing.length) d.enumProblems.push({ name, missing });
  }
  for (const [t, cols] of Object.entries(ref.tables)) {
    if (!live.tables[t]) { d.missingTables.push(t); continue; }
    for (const [col, rc] of Object.entries(cols)) {
      const lc = live.tables[t][col];
      if (!lc) { d.missingColumns.push({ table: t, column: col }); continue; }
      // the schema's pgvector block stores embeddings as vector(n) where the extension exists, real[] otherwise
      const pgvector = rc.type === "real[]" && /^vector\(\d+\)$/.test(lc.type);
      if (lc.type !== rc.type && !pgvector) d.typeDiffs.push({ table: t, column: col, from: lc.type, to: rc.type });
      if (lc.notnull !== rc.notnull) d.nullDiffs.push({ table: t, column: col, to: rc.notnull });
      if ((lc.default ?? null) !== (rc.default ?? null) && !rc.generated) d.defaultDiffs.push({ table: t, column: col, from: lc.default, to: rc.default });
    }
  }
  for (const t of Object.keys(live.tables)) if (!ref.tables[t]) d.extraTables.push(t);
  for (const [key, rc] of Object.entries(ref.constraints)) {
    if (!live.tables[rc.table]) continue;
    const lc = live.constraints[key];
    if (!lc) d.missingConstraints.push(rc);
    else if (lc.def !== rc.def) d.constraintDiffs.push({ ...rc, liveDef: lc.def });
  }
  for (const lc of Object.values(live.constraints))
    if (ref.tables[lc.table] && lc.kind === "f" && lc.refschema && lc.refschema !== "public") d.foreignSchemaFks.push(lc);
  for (const [name, ri] of Object.entries(ref.indexes)) {
    if (!live.tables[ri.table]) continue;
    const li = live.indexes[name];
    if (!li) d.missingIndexes.push({ name, ...ri });
    else if (li.def !== ri.def) d.indexDiffs.push({ name, ...ri, liveDef: li.def });
  }
  for (const [sig, rf] of Object.entries(ref.functions)) {
    if (VECTOR_DEPENDENT.test(sig)) continue; // built by the schema differently with/without pgvector
    const lf = live.functions[sig];
    if (lf && lf.result !== rf.result) d.functionDiffs.push({ sig, from: lf.result, to: rf.result });
    if (lf && lf.publicExec !== rf.publicExec) d.functionAclDiffs.push({ sig, to: rf.publicExec });
  }
  d.extraFunctions = Object.keys(live.functions).filter((s) => !ref.functions[s]).length;
  return d;
}

// Problems that must be zero after a repair.  (Missing tables/columns/indexes are created by the schema itself.)
export const blocking = (d) => ({
  missingTables: d.missingTables, missingColumns: d.missingColumns, typeDiffs: d.typeDiffs, nullDiffs: d.nullDiffs,
  defaultDiffs: d.defaultDiffs, missingConstraints: d.missingConstraints, constraintDiffs: d.constraintDiffs,
  foreignSchemaFks: d.foreignSchemaFks, missingIndexes: d.missingIndexes, indexDiffs: d.indexDiffs,
  enumProblems: d.enumProblems, functionDiffs: d.functionDiffs, functionAclDiffs: d.functionAclDiffs,
});
export const countProblems = (d) => Object.values(blocking(d)).reduce((n, v) => n + v.length, 0);
