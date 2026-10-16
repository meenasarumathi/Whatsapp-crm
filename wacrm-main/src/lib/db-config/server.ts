// ============================================================
// Server-side access to the migration 045 functions. Server-only:
// uses the service-role client, so callers must have checked that the
// user is the Super admin first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { platformAdminClient } from '@/lib/platform/server';
import { parseDbTables, type DbTable } from './tables';

/** Thrown when migration 045 hasn't been applied yet. */
export class DbConfigNotMigratedError extends Error {
  readonly status = 503 as const;
  constructor() {
    super(
      'Database config is not set up yet. Run supabase/migrations/045_db_config.sql in the Supabase SQL editor.'
    );
    this.name = 'DbConfigNotMigratedError';
  }
}

/** Thrown for a database refusal the Super admin can act on (e.g. a foreign key in the way). */
export class DbConfigError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409 = 409) {
    super(message);
    this.name = 'DbConfigError';
    this.status = status;
  }
}

function isMissingFunction(
  err: { code?: string; message?: string } | null
): boolean {
  return (
    !!err &&
    (err.code === 'PGRST202' ||
      err.code === '42883' ||
      /could not find the function|schema cache/i.test(err.message ?? ''))
  );
}

export async function fetchDbTables(
  db: SupabaseClient = platformAdminClient()
): Promise<DbTable[]> {
  const { data, error } = await db.rpc('db_config_tables');
  if (isMissingFunction(error)) throw new DbConfigNotMigratedError();
  if (error) throw error;
  return parseDbTables(data);
}

export async function fetchSchemaSql(
  db: SupabaseClient = platformAdminClient()
): Promise<string> {
  const { data, error } = await db.rpc('db_config_schema_sql');
  if (isMissingFunction(error)) throw new DbConfigNotMigratedError();
  if (error) throw error;
  return typeof data === 'string' ? data : '';
}

/** TRUNCATE the tables; returns the number of rows each held. */
export async function truncateTables(
  tables: string[],
  db: SupabaseClient = platformAdminClient()
): Promise<Record<string, number>> {
  const { data, error } = await db.rpc('db_config_truncate', {
    p_tables: tables,
  });
  if (isMissingFunction(error)) throw new DbConfigNotMigratedError();
  if (error) throw new DbConfigError(error.message);
  const out: Record<string, number> = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>))
      out[k] = Number(v) || 0;
  }
  return out;
}

export interface MaintenanceLogEntry {
  id: string;
  action: string;
  tables: string[];
  row_counts: Record<string, number>;
  performed_by_email: string | null;
  created_at: string;
}

export async function recentMaintenance(
  db: SupabaseClient = platformAdminClient(),
  limit = 10
): Promise<MaintenanceLogEntry[]> {
  const { data, error } = await db
    .from('db_maintenance_log')
    .select('id, action, tables, row_counts, performed_by_email, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as MaintenanceLogEntry[];
}

export async function logMaintenance(
  entry: {
    action: string;
    tables: string[];
    row_counts: Record<string, number>;
    performed_by: string;
    performed_by_email: string | null;
  },
  db: SupabaseClient = platformAdminClient()
): Promise<void> {
  const { error } = await db.from('db_maintenance_log').insert(entry);
  if (error)
    console.error(
      '[db-config] could not write maintenance log:',
      error.message
    );
}
