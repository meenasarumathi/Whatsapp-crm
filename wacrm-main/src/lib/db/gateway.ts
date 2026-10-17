// ============================================================
// Replays a query recorded in the browser (src/lib/db/browser.ts) against the
// signed-in user's database client. Row Level Security is the access control:
// the statement runs as role `wacrm_app` with app.user_id set to the session
// user, exactly the same policies that protect every other path.
// ============================================================

import type { DbClient } from "./client";
import type { DbResponse } from "./types";

export type RecordedCall = [method: string, ...args: unknown[]];

export type GatewayRequest =
  | { kind: "query"; table: string; ops: RecordedCall[] }
  | { kind: "rpc"; fn: string; args?: Record<string, unknown>; ops?: RecordedCall[] };

const QUERY_METHODS = new Set([
  "select", "insert", "upsert", "update", "delete",
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains",
  "not", "match", "filter", "or", "order", "limit", "range", "single", "maybeSingle",
]);
const RPC_METHODS = new Set(["single", "maybeSingle"]);

const IDENT = /^[a-z_][a-z0-9_]*$/;

function bad(message: string): DbResponse {
  return { data: null, error: { message, code: "400", details: null, hint: null }, count: null } as DbResponse;
}

export function validateGateway(req: unknown): string | null {
  if (!req || typeof req !== "object") return "Invalid request";
  const r = req as Record<string, unknown>;
  if (r.kind === "query") {
    if (typeof r.table !== "string" || !IDENT.test(r.table)) return "Invalid table";
  } else if (r.kind === "rpc") {
    if (typeof r.fn !== "string" || !IDENT.test(r.fn)) return "Invalid function";
  } else return "Invalid request kind";
  const ops = r.ops ?? [];
  if (!Array.isArray(ops) || ops.length > 100) return "Invalid operations";
  const allowed = r.kind === "query" ? QUERY_METHODS : RPC_METHODS;
  for (const op of ops) {
    if (!Array.isArray(op) || typeof op[0] !== "string" || !allowed.has(op[0])) return `Operation not allowed: ${String(Array.isArray(op) ? op[0] : op)}`;
  }
  return null;
}

export async function runGateway(db: DbClient, req: GatewayRequest): Promise<DbResponse> {
  const problem = validateGateway(req);
  if (problem) return bad(problem);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = req.kind === "query" ? db.from(req.table) : db.rpc(req.fn, req.args ?? {});
  for (const [method, ...args] of req.ops ?? []) {
    q = q[method](...args);
  }
  return (await q) as DbResponse;
}
