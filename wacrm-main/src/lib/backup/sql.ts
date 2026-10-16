// ============================================================
// SQL backup — turns rows into INSERT statements. Pure; no I/O.
//
// Used by GET /api/backup?format=sql. The output runs as-is in the
// the database SQL editor (or psql). Every INSERT ends in ON CONFLICT DO
// NOTHING, so replaying a file over existing data adds what is missing
// and never overwrites or fails on a duplicate.
// ============================================================

export interface SqlColumn {
  name: string;
  /** Postgres type, e.g. "text", "jsonb", "text[]", "vector(1536)". */
  type: string;
  /** Generated columns can't be inserted into, so they are skipped. */
  generated?: boolean;
  /** GENERATED … AS IDENTITY — needs OVERRIDING SYSTEM VALUE to keep the original ids. */
  identity?: boolean;
  /** Column default as Postgres prints it; a nextval(…) default means the column owns a sequence. */
  default?: string | null;
}

/** True when the column draws its values from a sequence (identity or serial). */
export function usesSequence(col: SqlColumn): boolean {
  return !!col.identity || /nextval\(/i.test(col.default ?? '');
}

export function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A quoted string literal. NUL bytes can't be stored in text, so they are dropped. */
export function sqlString(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`;
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return `{${value.map(arrayElement).join(',')}}`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One value as a SQL literal for a column of the given Postgres type. */
export function sqlLiteral(value: unknown, type: string): string {
  if (value === null || value === undefined) return 'NULL';
  const t = type.toLowerCase();

  if (t.endsWith('[]')) {
    if (Array.isArray(value))
      return `${sqlString(arrayElement(value))}::${type}`;
    return `${sqlString(String(value))}::${type}`;
  }
  if (t === 'json' || t === 'jsonb') {
    return `${sqlString(JSON.stringify(value))}::${t}`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object')
    return `${sqlString(JSON.stringify(value))}::jsonb`;
  return sqlString(String(value));
}

/** INSERT statements for `rows`, in batches. Empty string when there is nothing to insert. */
export function buildInsertSql(
  table: string,
  columns: SqlColumn[],
  rows: Record<string, unknown>[],
  batchSize = 100
): string {
  if (rows.length === 0) return '';
  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);
  const cols = columns.filter((c) => !c.generated && present.has(c.name));
  if (cols.length === 0) return '';

  const overriding = cols.some((c) => c.identity)
    ? 'OVERRIDING SYSTEM VALUE '
    : '';
  const head = `INSERT INTO public.${sqlIdent(table)} (${cols.map((c) => sqlIdent(c.name)).join(', ')}) ${overriding}VALUES\n`;
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const values = rows
      .slice(i, i + batchSize)
      .map(
        (row) =>
          `  (${cols.map((c) => sqlLiteral(row[c.name], c.type)).join(', ')})`
      )
      .join(',\n');
    statements.push(`${head}${values}\nON CONFLICT DO NOTHING;`);
  }
  return statements.join('\n');
}

export interface SqlTableData {
  table: string;
  columns: SqlColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Moves a sequence past the ids that were just inserted, so the next
 * new row doesn't collide with a restored one. A column with no
 * sequence behind it makes pg_get_serial_sequence return NULL, and
 * setval(NULL, …) is a no-op.
 */
export function buildSequenceSql(table: string, column: string): string {
  const t = sqlIdent(table);
  const c = sqlIdent(column);
  return (
    `SELECT setval(pg_get_serial_sequence(${sqlString(`public.${t}`)}, ${sqlString(column)}), ` +
    `coalesce(max(${c}), 1), max(${c}) IS NOT NULL) FROM public.${t};`
  );
}

/** The data half of a backup file: a comment header per table, then its INSERTs. */
export function buildDataSql(parts: SqlTableData[]): string {
  const blocks: string[] = [];
  for (const part of parts) {
    const insert = buildInsertSql(part.table, part.columns, part.rows);
    const lines = [
      `-- ${part.table}: ${part.rows.length} row${part.rows.length === 1 ? '' : 's'}` +
        (insert ? `\n${insert}` : ''),
    ];
    if (insert) {
      for (const col of part.columns) {
        if (!col.generated && usesSequence(col)) {
          lines.push(buildSequenceSql(part.table, col.name));
        }
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export function sqlFileHeader(lines: string[]): string {
  return lines.map((l) => `-- ${l}`).join('\n');
}
