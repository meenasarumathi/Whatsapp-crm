// ============================================================
// PostgreSQL connection pool (server only).
//
// Connection settings come from DATABASE_URL, e.g.
//   postgresql://postgres:strong_password@localhost:5433/wacrm
// or from the individual PG* variables used by docker-compose.yml.
// ============================================================

import { Pool, types } from "pg";

// Return values in the JSON-friendly shapes the app has always seen:
//   timestamptz -> ISO-8601 string, numeric/bigint -> number, date -> 'YYYY-MM-DD'.
const OID = { INT8: 20, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, NUMERIC: 1700, TIMESTAMPTZ_ARR: 1185, NUMERIC_ARR: 1231 };

function toIso(v: string): string {
  let s = v.replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  return s;
}
function parseArray(v: string, each: (x: string) => unknown): unknown[] {
  // Only flat arrays of simple scalars are expected for these types.
  const inner = v.replace(/^\{|\}$/g, "");
  if (!inner) return [];
  return inner.split(",").map((x) => (x === "NULL" ? null : each(x.replace(/^"|"$/g, ""))));
}
types.setTypeParser(OID.TIMESTAMPTZ, toIso);
types.setTypeParser(OID.TIMESTAMP, (v) => v.replace(" ", "T"));
types.setTypeParser(OID.DATE, (v) => v);
types.setTypeParser(OID.NUMERIC, (v) => Number(v));
types.setTypeParser(OID.INT8, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
types.setTypeParser(OID.TIMESTAMPTZ_ARR, (v) => parseArray(v, toIso));
types.setTypeParser(OID.NUMERIC_ARR, (v) => parseArray(v, Number));

export function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  const user = encodeURIComponent(process.env.POSTGRES_USER || "postgres");
  const pass = encodeURIComponent(process.env.POSTGRES_PASSWORD || "strong_password");
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5433";
  const db = process.env.POSTGRES_DB || "wacrm";
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const globalForPool = globalThis as unknown as { __wacrmPool?: Pool };

/** The shared pool. Survives Next.js hot reloads in development. */
export function getPool(): Pool {
  if (!globalForPool.__wacrmPool) {
    const pool = new Pool({
      connectionString: connectionString(),
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      options: "-c timezone=UTC",
    });
    pool.on("error", (err) => console.error("[db] idle client error:", err.message));
    globalForPool.__wacrmPool = pool;
  }
  return globalForPool.__wacrmPool;
}

export async function closePool(): Promise<void> {
  const p = globalForPool.__wacrmPool;
  globalForPool.__wacrmPool = undefined;
  if (p) await p.end();
}
