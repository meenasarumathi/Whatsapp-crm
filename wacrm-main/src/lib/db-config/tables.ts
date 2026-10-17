// ============================================================
// Database config — what the Super admin sees of the database and
// which tables may be truncated. Pure; no I/O.
//
// The table list comes from `db_config_tables()` (migration 045).
// The rules here decide, before anything is sent to Postgres:
//   - which tables are locked (truncating them would lock everyone out),
//   - which other tables must be truncated with a chosen table
//     (anything with a foreign key pointing at it), and
//   - the order tables must be restored in (parents before children).
// ============================================================

export interface DbColumn {
  name: string;
  /** Postgres type as written by format_type, e.g. "uuid", "text[]", "vector(1536)". */
  type: string;
  nullable: boolean;
  default: string | null;
  primary_key: boolean;
  generated: boolean;
  identity: boolean;
}

export interface DbTable {
  name: string;
  rls: boolean;
  /** Exact row count. */
  rows: number;
  columns: DbColumn[];
  /** Tables this one has a foreign key to (self-references left out). */
  references: string[];
  /** Tables that have a foreign key to this one (self-references left out). */
  referenced_by: string[];
}

/** Never truncated from the app: doing so would lock every user out or erase the audit log. */
export const PROTECTED_TABLES: readonly string[] = [
  'accounts',
  'profiles',
  'platform_users',
  'db_maintenance_log',
];

export function isProtectedTable(name: string): boolean {
  return PROTECTED_TABLES.includes(name);
}

export const TRUNCATE_CONFIRM_WORD = 'TRUNCATE';

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Validate the jsonb returned by `db_config_tables()`; drop anything malformed. */
export function parseDbTables(raw: unknown): DbTable[] {
  if (!Array.isArray(raw)) return [];
  const out: DbTable[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = asString(o.name);
    if (!name) continue;
    const columns: DbColumn[] = [];
    if (Array.isArray(o.columns)) {
      for (const c of o.columns) {
        if (!c || typeof c !== 'object') continue;
        const col = c as Record<string, unknown>;
        const colName = asString(col.name);
        if (!colName) continue;
        columns.push({
          name: colName,
          type: asString(col.type) || 'text',
          nullable: col.nullable !== false,
          default: typeof col.default === 'string' ? col.default : null,
          primary_key: col.primary_key === true,
          generated: col.generated === true,
          identity: col.identity === true,
        });
      }
    }
    out.push({
      name,
      rls: o.rls === true,
      rows: Number(o.rows) || 0,
      columns,
      references: asStrings(o.references),
      referenced_by: asStrings(o.referenced_by),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every table that must be truncated together with `selected`: the
 * selection plus, transitively, every table with a foreign key to it.
 * Postgres refuses a TRUNCATE otherwise (and we never use CASCADE).
 * Returned sorted; unknown names are ignored.
 */
export function truncateClosure(
  selected: string[],
  tables: DbTable[]
): string[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const result = new Set<string>();
  const queue = selected.filter((n) => byName.has(n));
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (result.has(name)) continue;
    result.add(name);
    for (const child of byName.get(name)?.referenced_by ?? []) {
      if (byName.has(child) && !result.has(child)) queue.push(child);
    }
  }
  return [...result].sort();
}

export interface TruncatePlan {
  /** Tables that will be truncated, including the dependents added automatically. */
  tables: string[];
  /** Dependents added on top of the user's selection. */
  added: string[];
  /** Protected tables hit by the selection or its dependents — non-empty means refuse. */
  blocked: string[];
  rows: number;
}

export function planTruncate(
  selected: string[],
  tables: DbTable[]
): TruncatePlan {
  const closure = truncateClosure(selected, tables);
  const chosen = new Set(selected);
  const byName = new Map(tables.map((t) => [t.name, t]));
  return {
    tables: closure,
    added: closure.filter((n) => !chosen.has(n)),
    blocked: closure.filter(isProtectedTable),
    rows: closure.reduce((sum, n) => sum + (byName.get(n)?.rows ?? 0), 0),
  };
}

/**
 * Restore order: a table comes after every table it references.
 * Ties break alphabetically; tables in a foreign-key cycle are appended
 * at the end rather than dropped.
 */
export function sortByDependency<
  T extends { name: string; references: string[] },
>(tables: T[]): T[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const pending = new Map<string, Set<string>>();
  for (const t of tables) {
    pending.set(
      t.name,
      new Set(t.references.filter((r) => byName.has(r) && r !== t.name))
    );
  }
  const ordered: T[] = [];
  const names = [...byName.keys()].sort();
  while (pending.size > 0) {
    const ready = names.filter(
      (n) => pending.has(n) && pending.get(n)!.size === 0
    );
    if (ready.length === 0) {
      // Cycle: emit what is left alphabetically.
      for (const n of names) if (pending.has(n)) ordered.push(byName.get(n)!);
      break;
    }
    for (const n of ready) {
      ordered.push(byName.get(n)!);
      pending.delete(n);
    }
    for (const deps of pending.values()) for (const n of ready) deps.delete(n);
  }
  return ordered;
}

/** Column used to page through a table in a stable order. */
export function pageOrderColumn(table: DbTable): string {
  const pk = table.columns.find((c) => c.primary_key);
  return (pk ?? table.columns[0])?.name ?? 'id';
}
