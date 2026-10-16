// ============================================================
// Database clients (server only).
//
//   createServiceDb()      owner connection, row level security is bypassed.
//                          For webhooks, cron jobs, API-key routes and admin tools.
//   createUserDb()         acts as the signed-in user from the session cookie:
//                          each statement runs in a transaction as role wacrm_app
//                          with app.user_id set, so every RLS policy applies.
//   createUserDbFor(id)    same, for an explicit user id (tests, background jobs).
// ============================================================

import { QueryBuilder, RpcBuilder } from "./builder";
import { getPool } from "./pool";
import type { Executor, Row, Runner } from "./types";

export interface DbUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  user_metadata: Record<string, unknown>;
}

export interface DbClient {
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Row): RpcBuilder;
  /** Who is acting. Service clients have no user. */
  auth: { getUser(): Promise<{ data: { user: DbUser | null }; error: { message: string } | null }> };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeClient(runner: Runner, getUser: () => Promise<DbUser | null>): DbClient {
  return {
    from: (table) => new QueryBuilder(runner, table),
    rpc: (fn, args = {}) => new RpcBuilder(runner, fn, args),
    auth: { getUser: async () => ({ data: { user: await getUser() }, error: null }) },
  };
}

async function loadUser(userId: string | null): Promise<DbUser | null> {
  if (!userId) return null;
  const { rows } = await getPool().query<{ id: string; email: string; raw_user_meta_data: Record<string, unknown> | null; created_at: string }>(
    "SELECT id, email, raw_user_meta_data, created_at FROM public.users WHERE id = $1",
    [userId],
  );
  const u = rows[0];
  if (!u) return null;
  const meta = u.raw_user_meta_data ?? {};
  return { id: u.id, email: u.email, full_name: typeof meta.full_name === "string" ? meta.full_name : null, created_at: u.created_at, user_metadata: meta };
}

const serviceRunner: Runner = async (fn) => {
  const pool = getPool();
  const exec: Executor = (sql, params) => pool.query(sql, params as unknown[]);
  return fn(exec);
};

export function createServiceDb(): DbClient {
  return makeClient(serviceRunner, async () => null);
}

function userRunner(userId: string | null): Runner {
  if (userId !== null && !UUID_RE.test(userId)) throw new Error("Invalid user id");
  return async (fn) => {
    const client = await getPool().connect();
    try {
      await client.query(
        `BEGIN; SELECT set_config('role','wacrm_app',true), set_config('app.user_id','${userId ?? ""}',true), set_config('app.mode','user',true)`,
      );
      const exec: Executor = (sql, params) => client.query(sql, params as unknown[]);
      const out = await fn(exec);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };
}

export function createUserDbFor(userId: string | null): DbClient {
  return makeClient(userRunner(userId), () => loadUser(userId));
}

/** Runs several statements as one user in a single transaction. */
export async function withUserTransaction<T>(userId: string, fn: (exec: Executor) => Promise<T>): Promise<T> {
  return userRunner(userId)(fn);
}

/** Client acting as the signed-in user of the current request (cookie session). */
export async function createUserDb(): Promise<DbClient> {
  const { getSessionUser } = await import("@/lib/auth/session");
  const user = await getSessionUser();
  return makeClient(userRunner(user?.id ?? null), async () => user);
}

export type { QueryBuilder, RpcBuilder };
