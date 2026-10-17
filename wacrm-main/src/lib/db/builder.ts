// ============================================================
// Query builder over node-postgres.
//
//   const { data, error } = await db
//     .from("contacts")
//     .select("id, name, tags:contact_tags(tag_id)")
//     .eq("account_id", accountId)
//     .order("created_at", { ascending: false })
//     .limit(50);
//
// Results are always { data, error, count } — the builder never throws.
// Table and column names are checked against the schema catalog and every
// value is a bound parameter, so nothing from a request can alter the SQL.
// ============================================================

import { getCatalog, type Catalog, type ColumnInfo, type ForeignKey, type TableInfo } from "./catalog";
import type { DbError, DbResponse, Executor, OrderOptions, Row, Runner, SelectOptions, UpsertOptions } from "./types";

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

class BuilderError extends Error {
  constructor(message: string, public code: string, public details: string | null = null, public hint: string | null = null) {
    super(message);
  }
}

function toDbError(err: unknown): DbError {
  if (err instanceof BuilderError) {
    return { message: err.message, code: err.code, details: err.details, hint: err.hint };
  }
  const e = err as { message?: string; code?: string; detail?: string; hint?: string };
  return { message: e?.message ?? String(err), code: e?.code, details: e?.detail ?? null, hint: e?.hint ?? null };
}

function statusFor(error: DbError | null, ok = 200): number {
  if (!error) return ok;
  switch (error.code) {
    case "23505":
    case "23503":
      return 409;
    case "42501":
      return 403;
    case "PGRST116":
      return 406;
    case "42P01":
    case "42883":
    case "PGRST205":
    case "PGRST202":
      return 404;
    default:
      return error.code?.startsWith("23") || error.code?.startsWith("22") ? 400 : 500;
  }
}

const qid = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// ------------------------------------------------------------
// Select-string parser:  "id, name, c:contacts!inner(id,name)"
// ------------------------------------------------------------

type SelectItem =
  | { kind: "col"; column: string; alias?: string }
  | { kind: "star" }
  | { kind: "embed"; alias: string; table: string; hint?: string; inner: boolean; items: SelectItem[] };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(spec: string): SelectItem[] {
  const items: SelectItem[] = [];
  for (const part of splitTop(spec)) {
    if (part === "*") {
      items.push({ kind: "star" });
      continue;
    }
    const open = part.indexOf("(");
    if (open === -1) {
      const m = part.match(/^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)(?:::[a-z]+)?$/);
      if (!m) throw new BuilderError(`Cannot parse select item "${part}"`, "PGRST100");
      items.push({ kind: "col", column: m[2], alias: m[1] });
      continue;
    }
    const head = part.slice(0, open).trim();
    const inner = part.slice(open + 1, part.lastIndexOf(")"));
    const m = head.match(/^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)((?:![A-Za-z0-9_]+)*)$/);
    if (!m) throw new BuilderError(`Cannot parse embed "${head}"`, "PGRST100");
    const hints = m[3] ? m[3].split("!").filter(Boolean) : [];
    const isInner = hints.includes("inner");
    const hint = hints.find((h) => h !== "inner" && h !== "left");
    items.push({
      kind: "embed",
      alias: m[1] ?? m[2],
      table: m[2],
      hint,
      inner: isInner,
      items: inner.trim() ? parseSelect(inner) : [{ kind: "star" }],
    });
  }
  return items;
}

// ------------------------------------------------------------
// Filters
// ------------------------------------------------------------

interface Filter {
  column: string;
  op: string;
  value?: unknown;
  negate?: boolean;
}
type Cond = { kind: "f"; f: Filter } | { kind: "or"; conds: Cond[] };

const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

function parseOrString(s: string): Cond[] {
  return splitTop(s).map((term) => {
    const m = term.match(/^(not\.)?([A-Za-z0-9_.]+)\.([a-z]+)\.([\s\S]*)$/);
    if (!m) throw new BuilderError(`Cannot parse or() term "${term}"`, "PGRST100");
    const [, neg, column, op, raw] = m;
    let value: unknown = raw;
    if (op === "in") value = raw.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
    else if (op === "is") value = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
    else if (op === "like" || op === "ilike") value = raw.replace(/\*/g, "%");
    return { kind: "f", f: { column, op, value, negate: !!neg } } as Cond;
  });
}

// ------------------------------------------------------------
// The builder
// ------------------------------------------------------------

type Mode = "select" | "insert" | "update" | "delete" | "upsert";

interface Ctx {
  cat: Catalog;
  params: unknown[];
  aliasSeq: number;
}

export class QueryBuilder implements PromiseLike<DbResponse> {
  private mode: Mode = "select";
  private selectSpec: string | null = null; // null => no RETURNING for mutations
  private selectOpts: SelectOptions = {};
  private conds: Cond[] = [];
  private orders: { column: string; asc: boolean; nullsFirst?: boolean }[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private rowsToWrite: Row[] = [];
  private patch: Row = {};
  private upsertOpts: UpsertOptions = {};
  private singleMode: "single" | "maybe" | null = null;

  constructor(private readonly runner: Runner, private readonly table: string) {}

  // ---- operations ------------------------------------------------------
  select(columns = "*", opts: SelectOptions = {}): this {
    this.selectSpec = columns;
    this.selectOpts = opts;
    return this;
  }
  insert(values: Row | Row[], _opts?: { count?: string }): this {
    this.mode = "insert";
    this.rowsToWrite = Array.isArray(values) ? values : [values];
    return this;
  }
  upsert(values: Row | Row[], opts: UpsertOptions = {}): this {
    this.mode = "upsert";
    this.rowsToWrite = Array.isArray(values) ? values : [values];
    this.upsertOpts = opts;
    return this;
  }
  update(values: Row): this {
    this.mode = "update";
    this.patch = values;
    return this;
  }
  delete(_opts?: { count?: string }): this {
    this.mode = "delete";
    return this;
  }

  // ---- filters ---------------------------------------------------------
  private add(column: string, op: string, value?: unknown, negate = false): this {
    this.conds.push({ kind: "f", f: { column, op, value, negate } });
    return this;
  }
  eq(c: string, v: unknown) { return this.add(c, "eq", v); }
  neq(c: string, v: unknown) { return this.add(c, "neq", v); }
  gt(c: string, v: unknown) { return this.add(c, "gt", v); }
  gte(c: string, v: unknown) { return this.add(c, "gte", v); }
  lt(c: string, v: unknown) { return this.add(c, "lt", v); }
  lte(c: string, v: unknown) { return this.add(c, "lte", v); }
  like(c: string, v: string) { return this.add(c, "like", v); }
  ilike(c: string, v: string) { return this.add(c, "ilike", v); }
  is(c: string, v: null | boolean) { return this.add(c, "is", v); }
  in(c: string, v: unknown[]) { return this.add(c, "in", v); }
  contains(c: string, v: unknown) { return this.add(c, "contains", v); }
  not(c: string, op: string, v: unknown) { return this.add(c, op, v, true); }
  match(q: Row) { for (const [k, v] of Object.entries(q)) this.eq(k, v); return this; }
  filter(c: string, op: string, v: unknown) { return this.add(c, op, v); }
  or(expr: string): this {
    this.conds.push({ kind: "or", conds: parseOrString(expr) });
    return this;
  }

  // ---- modifiers -------------------------------------------------------
  order(column: string, opts: OrderOptions = {}): this {
    this.orders.push({ column, asc: opts.ascending !== false, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n: number): this { this.limitN = n; return this; }
  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  single(): this { this.singleMode = "single"; return this; }
  maybeSingle(): this { this.singleMode = "maybe"; return this; }
  throwOnError(): this { return this; }
  returns<_T>(): this { return this; }
  abortSignal(_s?: unknown): this { return this; }

  then<R1 = DbResponse, R2 = never>(
    onfulfilled?: ((value: DbResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---- execution -------------------------------------------------------
  private async execute(): Promise<DbResponse> {
    try {
      const cat = await getCatalog();
      const info = cat.tables.get(this.table);
      if (!info) throw new BuilderError(`relation "public.${this.table}" does not exist`, "42P01");
      const ctx: Ctx = { cat, params: [], aliasSeq: 0 };
      return await this.runner((exec) => this.run(exec, ctx, info));
    } catch (err) {
      const error = toDbError(err);
      return { data: null, error, count: null, status: statusFor(error) };
    }
  }

  private async run(exec: Executor, ctx: Ctx, info: TableInfo): Promise<DbResponse> {
    const wantsRows = this.mode === "select" || this.selectSpec !== null;
    let sql: string;
    const T = qid(this.table);

    if (this.mode === "select") {
      const a = this.newAlias(ctx);
      const items = parseSelect(this.selectSpec ?? "*");
      const list = this.compileItems(ctx, info, a, items);
      const where = this.compileWhere(ctx, info, a, items);
      const from = `FROM public.${T} ${a}${where}`;
      let count: number | null = null;
      if (this.selectOpts.count) {
        // separate parameter list: the row query's list also holds embed parameters
        const c2: Ctx = { cat: ctx.cat, params: [], aliasSeq: 100 };
        const ca = this.newAlias(c2);
        const countFrom = `FROM public.${T} ${ca}${this.compileWhere(c2, info, ca, items)}`;
        const r = await exec(`SELECT count(*)::bigint AS n ${countFrom}`, c2.params);
        count = Number(r.rows[0].n);
      }
      if (this.selectOpts.head) return { data: null, error: null, count, status: 200 };
      sql = `SELECT ${list} ${from}${this.compileOrder(info, a)}${this.compileLimit()}`;
      const res = await exec(sql, ctx.params);
      return this.shape(res.rows, count);
    }

    // ---- mutations ----
    let stmt: string;
    if (this.mode === "insert" || this.mode === "upsert") {
      if (this.rowsToWrite.length === 0) return this.shape([], null, true);
      const colSet: string[] = [];
      for (const row of this.rowsToWrite) {
        for (const k of Object.keys(row)) {
          if (row[k] === undefined) continue;
          if (!info.columns.has(k)) throw new BuilderError(`Could not find the '${k}' column of '${this.table}'`, "PGRST204");
          if (!colSet.includes(k)) colSet.push(k);
        }
      }
      if (colSet.length === 0) {
        stmt = `INSERT INTO public.${T} DEFAULT VALUES`;
      } else {
        const tuples = this.rowsToWrite.map((row) =>
          "(" + colSet.map((k) => (row[k] === undefined ? "DEFAULT" : this.bind(ctx, info.columns.get(k)!, row[k]))).join(", ") + ")",
        );
        stmt = `INSERT INTO public.${T} (${colSet.map(qid).join(", ")}) VALUES ${tuples.join(", ")}`;
      }
      if (this.mode === "upsert") {
        const target = this.upsertOpts.onConflict
          ? this.upsertOpts.onConflict.split(",").map((s) => s.trim())
          : info.primaryKey;
        for (const c of target) if (!info.columns.has(c)) throw new BuilderError(`Unknown conflict column ${c}`, "42703");
        const updatable = colSet.filter((c) => !target.includes(c));
        stmt +=
          ` ON CONFLICT (${target.map(qid).join(", ")}) ` +
          (this.upsertOpts.ignoreDuplicates || updatable.length === 0
            ? "DO NOTHING"
            : `DO UPDATE SET ${updatable.map((c) => `${qid(c)} = EXCLUDED.${qid(c)}`).join(", ")}`);
      }
    } else if (this.mode === "update") {
      const keys = Object.keys(this.patch).filter((k) => this.patch[k] !== undefined);
      if (keys.length === 0) throw new BuilderError("Empty update", "22023");
      const sets = keys.map((k) => {
        const col = info.columns.get(k);
        if (!col) throw new BuilderError(`Could not find the '${k}' column of '${this.table}'`, "PGRST204");
        return `${qid(k)} = ${this.bind(ctx, col, this.patch[k])}`;
      });
      const alias = this.newAlias(ctx);
      stmt = `UPDATE public.${T} ${alias} SET ${sets.join(", ")}` + this.compileWhere(ctx, info, alias, []);
    } else {
      const alias = this.newAlias(ctx);
      stmt = `DELETE FROM public.${T} ${alias}` + this.compileWhere(ctx, info, alias, []);
    }

    if (!wantsRows) {
      const res = await exec(stmt, ctx.params);
      return { data: null, error: null, count: res.rowCount, status: this.mode === "insert" || this.mode === "upsert" ? 201 : 204 };
    }
    const items = parseSelect(this.selectSpec ?? "*");
    const a = this.newAlias(ctx);
    const list = this.compileItems(ctx, info, a, items);
    sql = `WITH r AS (${stmt} RETURNING *) SELECT ${list} FROM r ${a}`;
    const res = await exec(sql, ctx.params);
    return this.shape(res.rows, null, this.mode === "insert" || this.mode === "upsert");
  }

  private shape(rows: Row[], count: number | null, created = false): DbResponse {
    if (this.singleMode) {
      if (rows.length === 1) return { data: rows[0], error: null, count, status: 200 };
      if (rows.length === 0 && this.singleMode === "maybe") return { data: null, error: null, count, status: 200 };
      const error: DbError = {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: `The result contains ${rows.length} rows`,
        hint: null,
      };
      return { data: null, error, count, status: 406 };
    }
    return { data: rows, error: null, count, status: created ? 201 : 200 };
  }

  // ---- SQL pieces ------------------------------------------------------
  private newAlias(ctx: Ctx) { return `t${ctx.aliasSeq++}`; }

  private bind(ctx: Ctx, col: ColumnInfo, value: unknown): string {
    if (value === null) return "NULL";
    let v: unknown = value;
    if (col.isJson) v = JSON.stringify(value);
    else if (col.type === "jsonb[]" || col.type === "json[]") v = (value as unknown[]).map((x) => JSON.stringify(x));
    ctx.params.push(v);
    return `$${ctx.params.length}::${col.type}`;
  }

  private bindArray(ctx: Ctx, col: ColumnInfo, values: unknown[]): string {
    ctx.params.push(values);
    return `$${ctx.params.length}::${col.type.replace(/\[\]$/, "")}[]`;
  }

  private compileItems(ctx: Ctx, info: TableInfo, a: string, items: SelectItem[]): string {
    const out: string[] = [];
    for (const it of items) {
      if (it.kind === "star") out.push(`${a}.*`);
      else if (it.kind === "col") {
        if (!info.columns.has(it.column)) throw new BuilderError(`column ${this.table}.${it.column} does not exist`, "42703");
        out.push(`${a}.${qid(it.column)}${it.alias ? ` AS ${qid(it.alias)}` : ""}`);
      } else {
        out.push(`${this.compileEmbed(ctx, info, a, it, [])} AS ${qid(it.alias)}`);
      }
    }
    return out.join(", ") || `${a}.*`;
  }

  /** Find the foreign key joining `base` and `target`; returns the FK and which side holds it. */
  private relation(ctx: Ctx, base: string, target: string, hint?: string): { fk: ForeignKey; baseHoldsFk: boolean } {
    const cands: { fk: ForeignKey; baseHoldsFk: boolean }[] = [];
    for (const fk of ctx.cat.fks) {
      if (fk.table === base && fk.refTable === target) cands.push({ fk, baseHoldsFk: true });
      if (fk.table === target && fk.refTable === base) cands.push({ fk, baseHoldsFk: false });
    }
    let pick = cands;
    if (hint) {
      pick = cands.filter((c) => c.fk.name === hint || c.fk.columns.includes(hint));
    }
    if (pick.length === 0) throw new BuilderError(`Could not find a relationship between '${base}' and '${target}'`, "PGRST200");
    if (pick.length > 1) throw new BuilderError(`More than one relationship was found for '${base}' and '${target}'`, "PGRST201");
    return pick[0];
  }

  private joinCond(rel: { fk: ForeignKey; baseHoldsFk: boolean }, baseAlias: string, targetAlias: string): string {
    const { fk, baseHoldsFk } = rel;
    return fk.columns
      .map((c, i) => {
        const r = fk.refColumns[i];
        return baseHoldsFk ? `${targetAlias}.${qid(r)} = ${baseAlias}.${qid(c)}` : `${targetAlias}.${qid(c)} = ${baseAlias}.${qid(r)}`;
      })
      .join(" AND ");
  }

  /** Filters addressed to an embed ("alias.column") belong inside its subquery. */
  private embedConds(alias: string): Cond[] {
    const pick = (c: Cond): Cond | null => {
      if (c.kind === "f") return c.f.column.startsWith(alias + ".") ? c : null;
      return null;
    };
    return this.conds.map(pick).filter((x): x is Cond => !!x);
  }

  private compileEmbed(ctx: Ctx, base: TableInfo, baseAlias: string, it: Extract<SelectItem, { kind: "embed" }>, _unused: Cond[]): string {
    const target = ctx.cat.tables.get(it.table);
    if (!target) throw new BuilderError(`Could not find a relationship between '${base.name}' and '${it.table}'`, "PGRST200");
    const rel = this.relation(ctx, base.name, it.table, it.hint);
    const e = this.newAlias(ctx);
    const list = this.compileItems(ctx, target, e, it.items);
    const join = this.joinCond(rel, baseAlias, e);
    const own = this.embedConds(it.alias).map((c) => this.compileCond(ctx, target, e, c, it.alias));
    const where = [join, ...own].join(" AND ");
    const single = rel.baseHoldsFk || rel.fk.unique;
    const sub = this.newAlias(ctx);
    if (single) return `(SELECT to_jsonb(${sub}) FROM (SELECT ${list} FROM public.${qid(it.table)} ${e} WHERE ${where} LIMIT 1) ${sub})`;
    return `COALESCE((SELECT jsonb_agg(to_jsonb(${sub})) FROM (SELECT ${list} FROM public.${qid(it.table)} ${e} WHERE ${where}) ${sub}), '[]'::jsonb)`;
  }

  private compileWhere(ctx: Ctx, info: TableInfo, a: string, items: SelectItem[]): string {
    const parts: string[] = [];
    for (const c of this.conds) {
      if (c.kind === "f" && c.f.column.includes(".")) continue; // handled in the embed
      parts.push(this.compileCond(ctx, info, a, c));
    }
    // !inner embeds: the parent row needs at least one matching child
    for (const it of items) {
      if (it.kind === "embed" && it.inner) {
        const target = ctx.cat.tables.get(it.table);
        if (!target) continue;
        const rel = this.relation(ctx, info.name, it.table, it.hint);
        const e = this.newAlias(ctx);
        const own = this.embedConds(it.alias).map((c) => this.compileCond(ctx, target, e, c, it.alias));
        parts.push(`EXISTS (SELECT 1 FROM public.${qid(it.table)} ${e} WHERE ${[this.joinCond(rel, a, e), ...own].join(" AND ")})`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  private compileCond(ctx: Ctx, info: TableInfo, a: string, c: Cond, stripPrefix?: string): string {
    if (c.kind === "or") return "(" + c.conds.map((x) => this.compileCond(ctx, info, a, x, stripPrefix)).join(" OR ") + ")";
    const f = c.f;
    const name = stripPrefix && f.column.startsWith(stripPrefix + ".") ? f.column.slice(stripPrefix.length + 1) : f.column;
    const col = info.columns.get(name);
    if (!col) throw new BuilderError(`column ${info.name}.${name} does not exist`, "42703");
    const ref = `${a}.${qid(name)}`;
    let sql: string;
    switch (f.op) {
      case "is":
        sql = f.value === null ? `${ref} IS NULL` : `${ref} IS ${f.value ? "TRUE" : "FALSE"}`;
        break;
      case "in": {
        const arr = (f.value as unknown[]) ?? [];
        sql = arr.length === 0 ? "FALSE" : `${ref} = ANY(${this.bindArray(ctx, col, arr)})`;
        break;
      }
      case "contains":
        sql = col.isJson ? `${ref} @> ${this.bind(ctx, col, f.value)}` : `${ref} @> ${this.bind(ctx, col, f.value)}`;
        break;
      default: {
        const op = OPS[f.op];
        if (!op) throw new BuilderError(`Unsupported operator ${f.op}`, "PGRST100");
        if (f.value === null) throw new BuilderError(`${f.op}(${name}, null) is not supported; use is()`, "22004");
        sql = `${ref} ${op} ${this.bind(ctx, col, f.value)}`;
      }
    }
    return f.negate ? `NOT (${sql})` : sql;
  }

  private compileOrder(info: TableInfo, a: string): string {
    if (!this.orders.length) return "";
    return (
      " ORDER BY " +
      this.orders
        .map((o) => {
          if (!info.columns.has(o.column)) throw new BuilderError(`column ${info.name}.${o.column} does not exist`, "42703");
          return `${a}.${qid(o.column)} ${o.asc ? "ASC" : "DESC"}${o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST"}`;
        })
        .join(", ")
    );
  }

  private compileLimit(): string {
    let s = "";
    if (this.limitN !== null) s += ` LIMIT ${Math.max(0, Math.floor(this.limitN))}`;
    if (this.offsetN !== null) s += ` OFFSET ${Math.max(0, Math.floor(this.offsetN))}`;
    return s;
  }
}

// ------------------------------------------------------------
// Stored-function calls:  db.rpc("filter_contacts_by_tags", { ... })
// ------------------------------------------------------------

export class RpcBuilder implements PromiseLike<DbResponse> {
  private singleMode: "single" | "maybe" | null = null;
  constructor(private readonly runner: Runner, private readonly fn: string, private readonly args: Row) {}

  single(): this { this.singleMode = "single"; return this; }
  maybeSingle(): this { this.singleMode = "maybe"; return this; }

  then<R1 = DbResponse, R2 = never>(
    onfulfilled?: ((value: DbResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<DbResponse> {
    try {
      const cat = await getCatalog();
      const f = cat.functions.get(this.fn);
      if (!f) {
        throw new BuilderError(`Could not find the function public.${this.fn} in the schema cache`, "PGRST202");
      }
      const params: unknown[] = [];
      const named: string[] = [];
      for (const [k, v] of Object.entries(this.args)) {
        if (v === undefined) continue;
        const idx = f.argNames.indexOf(k);
        if (idx === -1) throw new BuilderError(`Function ${this.fn} has no argument "${k}"`, "PGRST202");
        const type = f.argTypes[idx];
        let value: unknown = v;
        if (v !== null) {
          if (type === "json" || type === "jsonb") value = JSON.stringify(v);
          else if (type === "jsonb[]" || type === "json[]") value = (v as unknown[]).map((x) => JSON.stringify(x));
        }
        params.push(value);
        named.push(`${qid(k)} => $${params.length}::${type}`);
      }
      const call = `public.${qid(this.fn)}(${named.join(", ")})`;
      const sql = f.returnsSet ? `SELECT * FROM ${call}` : `SELECT ${call} AS result`;
      const res = await this.runner((exec) => exec(sql, params));
      let data: unknown;
      if (f.returnsSet) data = res.rows;
      else data = res.rows[0]?.result ?? null;
      if (this.singleMode && f.returnsSet) {
        const rows = data as Row[];
        if (rows.length === 1) data = rows[0];
        else if (rows.length === 0 && this.singleMode === "maybe") data = null;
        else {
          const error: DbError = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null };
          return { data: null, error, count: null, status: 406 };
        }
      }
      return { data, error: null, count: null, status: 200 };
    } catch (err) {
      const error = toDbError(err);
      return { data: null, error, count: null, status: statusFor(error) };
    }
  }
}
