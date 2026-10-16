// Checks the PostgreSQL connection the app will use.   Usage: npm run db:test
// Reads DATABASE_URL from the environment, .env.local or .env (same as the app).
import { existsSync } from "node:fs";
import pg from "pg";

for (const f of [".env.local", ".env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch {} }
const stripSchema = (u) => u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");
const url = stripSchema(process.env.DATABASE_URL || "postgresql://postgres:strong_password@localhost:5433/wacrm");
const shown = url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:****@");

let failed = false;
const line = (ok, label, detail = "") => { if (!ok) failed = true; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  - " + detail : ""}`); };
const hint = (e) => ({
  "28P01": "wrong user or password in DATABASE_URL",
  "28000": "this user is not allowed to connect",
  "3D000": "database does not exist - create it: CREATE DATABASE wacrm;",
  ECONNREFUSED: "nothing is listening on that host/port - is the container running? (docker ps)",
  ENOTFOUND: "host name not found",
  ETIMEDOUT: "connection timed out",
}[e.code] || "");

console.log("Connecting to", shown);
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
} catch (e) {
  line(false, "connect", `${e.code || ""} ${e.message}`.trim());
  if (hint(e)) console.log("      ->", hint(e));
  process.exit(1);
}
const q = async (sql) => (await client.query(sql)).rows;
try {
  const [v] = await q("select current_user u, current_database() d, version() v, inet_server_port() p");
  line(true, "connect", `user=${v.u} db=${v.d} port=${v.p}`);
  line(true, "server", v.v.split(",")[0]);
  const [r] = await q("select rolsuper s, rolcreaterole cr from pg_roles where rolname = current_user");
  line(true, "privileges", `superuser=${r.s} createrole=${r.cr}` + (r.s ? "" : "  (data import needs superuser; schema needs createrole or superuser)"));
  const [w] = await q("select exists(select 1 from pg_roles where rolname='wacrm_app') a");
  console.log(`INFO  app role wacrm_app: ${w.a ? "present" : "not created yet (db:init creates it)"}`);
  const [t] = await q("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> 'schema_migrations'");
  const [u] = await q("select to_regclass('public.users') is not null has");
  line(u.has, "schema applied", u.has ? `${t.n} tables in public` : "run: npm run db:init");
  if (u.has) {
    const [c] = await q("select (select count(*) from users)::int users, (select count(*) from contacts)::int contacts, (select count(*) from messages)::int messages");
    console.log(`INFO  rows: users=${c.users} contacts=${c.contacts} messages=${c.messages}`);
    await client.query("begin"); await client.query("create temp table _wacrm_probe(i int) on commit drop"); await client.query("insert into _wacrm_probe values (1)"); await client.query("rollback");
    line(true, "write test", "temp table insert/rollback ok");
  }
  const [x] = await q("select exists(select 1 from pg_extension where extname='vector') e");
  console.log(`INFO  pgvector extension: ${x.e ? "installed" : "not installed (AI semantic search disabled, everything else works)"}`);
} catch (e) {
  line(false, "query", `${e.code || ""} ${e.message}`.trim());
}
await client.end();
console.log(failed ? "\nRESULT: problems found" : "\nRESULT: database connection OK");
process.exit(failed ? 1 : 0);
