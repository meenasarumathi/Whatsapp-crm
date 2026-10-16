// Shapes shared by the query builder and everything that calls it.
// They mirror what the app already expects from a REST-style data client:
// every call resolves to { data, error, count } and never throws.

export interface DbError {
  message: string;
  /** PostgreSQL SQLSTATE (e.g. '23505') or a PGRST* code for "no/many rows". */
  code?: string;
  details?: string | null;
  hint?: string | null;
}

// Rows are untyped (no generated schema types), as with the previous client.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbResponse<T = any> {
  data: T | null;
  error: DbError | null;
  count: number | null;
  status: number;
}

export type Row = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Runs one parameterised statement and returns its rows. */
export type Executor = (sql: string, params: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

/** Runs several statements on one connection/transaction (count + rows). */
export type Runner = <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;

export interface SelectOptions {
  count?: "exact" | "planned" | "estimated";
  head?: boolean;
}

export interface UpsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

export interface OrderOptions {
  ascending?: boolean;
  nullsFirst?: boolean;
}
