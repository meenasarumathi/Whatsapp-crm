// TEST HELPER - builds a stand-in for the old hosted database inside a scratch PostgreSQL and fills
// it with randomised but constraint-valid data (nasty strings, JSON, arrays, microsecond timestamps,
// storage URLs). Used to rehearse export.mjs / import / validate.mjs without touching a real project.
//
//   ADMIN_URL=postgresql://postgres:pw@localhost:5433/postgres node seed-source.mjs [dbname=sb_sim] [rowsPerTable=40]
import pg from "pg";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";

const admin = process.env.ADMIN_URL || "postgresql://postgres:strong_password@127.0.0.1:5433/postgres";
const dbName = process.argv[2] || "sb_sim";
const N = Number(process.argv[3] || 40);
const SCHEMA_DIR = new URL("../../supabase/schema/", import.meta.url).pathname;
const SB_URL = process.env.FAKE_SUPABASE_URL || "https://abcdefghijkl.supabase.co";

// seeded PRNG for repeatable data
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const NASTY = ["O'Brien", 'say "hi"', "back\\slash", "emoji 😀🎉", "line1\nline2\r\nline3", "NULL", "tab\there", "'; DROP TABLE x; --", "$$dollar$$", "日本語テキスト", "مرحبا بالعالم", "  spaces  ", "", "%_like", "{curly}", "[bracket]", "ünïcödé", "a".repeat(300)];
const word = () => pick(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]) + int(1, 9999);
const ts = () => new Date(Date.UTC(2025, 0, 1) + int(0, 600) * 86400000 + int(0, 86399999)).toISOString().replace("Z", String(int(0, 999)).padStart(3, "0") + "+00");

async function main() {
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await a.query(`CREATE DATABASE ${dbName}`);
  await a.end();
  const url = admin.replace(/\/[^/]*$/, "/" + dbName);
  const psql = (f) => execFileSync("psql", [url, "-q", "-v", "ON_ERROR_STOP=0", "-f", f], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=error" }, stdio: ["ignore", "ignore", "pipe"] });
  psql(SCHEMA_DIR + "00_supabase_stubs.sql");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  // make auth.users look like the hosted one
  await c.query(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS instance_id uuid, ADD COLUMN IF NOT EXISTS aud text DEFAULT 'authenticated', ADD COLUMN IF NOT EXISTS role text DEFAULT 'authenticated',
    ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{"provider":"email"}',
    ADD COLUMN IF NOT EXISTS confirmation_token text, ADD COLUMN IF NOT EXISTS is_super_admin boolean`);
  await c.query(`ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS metadata jsonb, ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`);
  psql(SCHEMA_DIR + "wacrm_schema.sql");

  // ---- users (trigger on auth.users creates account + profile + platform row) ----
  const hash = await bcrypt.hash("secret123", 10);
  const users = [];
  for (const [email, name] of [["owner@example.com", "Olive Owner"], ["agent@example.com", "Andy Agent"], ["O'Neil+tag@example.com", "Zoë O'Neil"], ["viewer@example.com", "Vic Viewer"]]) {
    const r = await c.query(`INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at, last_sign_in_at) VALUES ($1,$2,$3::jsonb, now(), now()) RETURNING id`, [email, hash, JSON.stringify({ full_name: name })]);
    users.push(r.rows[0].id);
  }
  // ---- generic fuzz seeding ----
  const cols = await c.query(`SELECT c.relname t, a.attname n, format_type(a.atttypid, a.atttypmod) ft, a.attnotnull nn, a.atthasdef hd, a.attgenerated <> '' gen, t.typtype tt, a.atttypid
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_type t ON t.oid=a.atttypid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`);
  const cons = await c.query(`SELECT conrelid::regclass::text t, contype k, pg_get_constraintdef(oid) d,
     (SELECT array_agg(attname::text) FROM pg_attribute WHERE attrelid=conrelid AND attnum = ANY(conkey)) cols,
     confrelid::regclass::text rt, (SELECT array_agg(attname::text) FROM pg_attribute WHERE attrelid=confrelid AND attnum = ANY(confkey)) rcols
     FROM pg_constraint WHERE connamespace='public'::regnamespace`);
  const enums = {};
  for (const r of (await c.query(`SELECT t.oid, array_agg(e.enumlabel ORDER BY e.enumsortorder) l FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY t.oid`)).rows) enums[r.oid] = r.l;
  const strip = (s) => s.replace(/^public\./, "").replace(/"/g, "");
  const tables = {};
  for (const r of cols.rows) (tables[r.t] ??= { cols: [], fks: [], checks: {}, pk: [] }).cols.push(r);
  for (const r of cons.rows) {
    const t = tables[strip(r.t)]; if (!t) continue;
    if (r.k === "f") t.fks.push({ cols: r.cols, rt: strip(r.rt), rcols: r.rcols });
    if (r.k === "p") t.pk = r.cols;
    if (r.k === "c") {
      const m = r.d.match(/\(\(?"?(\w+)"?\)?(?:::text)? = ANY \(\(?ARRAY\[(.*?)\]\)?(?:::text\[\])?\)\)/s);
      if (m) t.checks[m[1]] = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    }
  }
  // dependency order
  const names = Object.keys(tables);
  const done = new Set(), order = [];
  const skip = new Set(["users"]);
  while (order.length < names.length) {
    const before = order.length;
    for (const n of names) if (!done.has(n) && tables[n].fks.every((f) => f.rt === n || done.has(f.rt) || !tables[f.rt])) { order.push(n); done.add(n); }
    if (order.length === before) { for (const n of names) if (!done.has(n)) { order.push(n); done.add(n); } }
  }
  const pool = {}; // table -> rows of {col: value} (keys only)
  const keyCols = (t) => new Set([...tables[t].pk, ...tables[t].fks.flatMap((f) => f.cols)]);
  const loadPool = async (t) => {
    const r = await c.query(`SELECT * FROM public."${t}" LIMIT 200`).catch(() => ({ rows: [] }));
    pool[t] = r.rows;
  };
  const genValue = (col, t, tbl) => {
    if (tbl.checks[col.n]) return pick(tbl.checks[col.n]);
    if (enums[col.atttypid]) return pick(enums[col.atttypid]);
    const ft = col.ft;
    if (ft === "uuid") return crypto.randomUUID();
    if (ft === "text" || /^character/.test(ft)) {
      if (/url|media/.test(col.n)) return `${SB_URL}/storage/v1/object/public/chat-media/account-x/${word()}.png`;
      if (/email/.test(col.n)) return `${word()}@example.com`;
      if (/phone/.test(col.n)) return `+1555${int(1000000, 9999999)}`;
      return rnd() < 0.35 ? pick(NASTY) : `${word()} ${word()}`;
    }
    if (ft === "integer" || ft === "smallint") return int(0, 500);
    if (ft === "bigint") return int(0, 100000);
    if (ft === "boolean") return rnd() < 0.5;
    if (/^timestamp/.test(ft)) return ts();
    if (ft === "date") return ts().slice(0, 10);
    if (ft === "jsonb" || ft === "json") return JSON.stringify(rnd() < 0.5 ? { a: int(1, 9), b: [pick(NASTY), null, true], nested: { k: `${SB_URL}/storage/v1/object/public/flow-media/account-x/${word()}.mp4` } } : [1, "two", { three: 3 }]);
    if (ft === "text[]") return [pick(NASTY), word()];
    if (ft === "uuid[]") return [crypto.randomUUID()];
    if (/^numeric|^double|^real/.test(ft)) return (rnd() * 1000).toFixed(2);
    if (ft === "tsvector") return null;
    return undefined;
  };
  const failures = {};
  await c.query("BEGIN");
  for (const t of order) {
    if (skip.has(t)) continue;
    const tbl = tables[t];
    const existing = (await c.query(`SELECT count(*)::int n FROM public."${t}"`)).rows[0].n;
    const want = ["accounts", "profiles", "platform_users"].includes(t) ? 0 : N;
    let made = 0;
    for (let i = 0; i < want * 3 && made < want; i++) {
      const vals = {};
      const fkv = {};
      for (const fk of tbl.fks) {
        if (fk.rt === "users" || fk.rt === "auth.users") { for (const cname of fk.cols) fkv[cname] = pick(users); continue; }
        if (fk.rt === t) continue; // self reference stays null
        const parent = (pool[fk.rt] ??= []);
        if (!parent.length) await loadPool(fk.rt);
        if (!pool[fk.rt].length) continue;
        const row = pick(pool[fk.rt]);
        fk.cols.forEach((cname, k) => (fkv[cname] = row[fk.rcols[k]]));
      }
      for (const col of tbl.cols) {
        if (col.gen) continue;
        if (col.n in fkv) { vals[col.n] = fkv[col.n]; continue; }
        const isFk = tbl.fks.some((f) => f.cols.includes(col.n));
        if (isFk && !col.nn) continue;
        if (col.hd && rnd() < 0.5 && !tbl.checks[col.n]) continue;
        if (!col.nn && rnd() < 0.25) continue;
        const v = genValue(col, t, tbl);
        if (v !== undefined) vals[col.n] = v;
      }
      const keys = Object.keys(vals);
      if (!keys.length) continue;
      try {
        await c.query("SAVEPOINT s");
        await c.query(`INSERT INTO public."${t}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, j) => `$${j + 1}`).join(",")}) ON CONFLICT DO NOTHING`, keys.map((k) => vals[k]));
        await c.query("RELEASE s");
        made++;
      } catch (e) {
        await c.query("ROLLBACK TO s");
        failures[t] = (failures[t] || 0) + 1;
        if (failures[t] === 1) failures[`${t}:first`] = e.message.slice(0, 140);
      }
    }
    await loadPool(t);
    const total = (await c.query(`SELECT count(*)::int n FROM public."${t}"`)).rows[0].n;
    console.log(`  ${String(total).padStart(5)} ${t}`);
  }
  await c.query("COMMIT");
  // storage inventory: a few files referenced by the data (served by the fake storage server in the test)
  await c.query(`INSERT INTO storage.buckets (id,name,public) VALUES ('avatars','avatars',true),('chat-media','chat-media',true),('flow-media','flow-media',true) ON CONFLICT DO NOTHING`);
  const accs = (await c.query("SELECT id FROM public.accounts LIMIT 2")).rows.map((r) => r.id);
  const objs = [];
  for (const acc of accs) {
    objs.push(["chat-media", `account-${acc}/1770000000001-photo.png`, "image/png", 8], ["chat-media", `account-${acc}/inbound/1234567890123456-invoice.pdf`, "application/pdf", 1200], ["flow-media", `account-${acc}/1770000000002-clip.mp4`, "video/mp4", 5000]);
  }
  objs.push(["avatars", `${users[0]}/avatar-1770000000003.png`, "image/png", 8]);
  for (const [b, n, m, s] of objs) await c.query(`INSERT INTO storage.objects (bucket_id,name,metadata) VALUES ($1,$2,$3::jsonb)`, [b, n, JSON.stringify({ size: s, mimetype: m })]);
  // point some real rows at real objects
  await c.query(`UPDATE public.messages SET media_url = $1 WHERE id = (SELECT id FROM public.messages LIMIT 1)`, [`${SB_URL}/storage/v1/object/public/chat-media/${objs[0][1]}`]);
  await c.query(`UPDATE public.profiles SET avatar_url = $1 WHERE user_id = $2`, [`${SB_URL}/storage/v1/object/public/avatars/${objs[objs.length - 1][1]}`, users[0]]);
  console.log("seed failures (constraint-rejected random rows, expected):", JSON.stringify(Object.fromEntries(Object.entries(failures).filter(([k]) => !k.endsWith(":first")))));
  console.log(JSON.stringify({ url, users: users.length, storageObjects: objs.length }));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
