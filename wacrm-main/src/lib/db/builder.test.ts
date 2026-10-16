// Integration tests for the query builder. They need a PostgreSQL with db/schema.sql applied
// (docker compose up -d postgres) and are skipped when TEST_DATABASE_URL is not set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("query builder", () => {
  let db: typeof import("./client");
  let pool: typeof import("./pool");
  const ids = { user: "", account: "", contact: "" };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pool = await import("./pool");
    db = await import("./client");
    const p = pool.getPool();
    await p.query("TRUNCATE public.users CASCADE");
    const u = await p.query("INSERT INTO public.users (email, password_hash, raw_user_meta_data) VALUES ('t@x.com','h','{\"full_name\":\"T\"}') RETURNING id");
    ids.user = u.rows[0].id;
    ids.account = (await p.query("SELECT account_id FROM profiles WHERE user_id=$1", [ids.user])).rows[0].account_id;
  });
  afterAll(async () => { await pool.closePool(); });

  it("inserts, selects with filters, embeds and counts", async () => {
    const svc = db.createServiceDb();
    const ins = await svc.from("contacts").insert({ user_id: ids.user, account_id: ids.account, phone: "+15550001", name: "Ann" }).select().single();
    expect(ins.error).toBeNull();
    ids.contact = ins.data.id;
    const tag = await svc.from("tags").insert({ user_id: ids.user, account_id: ids.account, name: "vip" }).select("id").single();
    await svc.from("contact_tags").insert({ contact_id: ids.contact, tag_id: tag.data.id });

    const r = await svc.from("contacts").select("id, name, tags:contact_tags(tag_id)", { count: "exact" }).eq("account_id", ids.account).order("created_at", { ascending: false });
    expect(r.error).toBeNull();
    expect(r.count).toBe(1);
    expect(r.data![0].tags).toEqual([{ tag_id: tag.data.id }]);

    const inner = await svc.from("contacts").select("id, tag_filter:contact_tags!inner(tag_id)").eq("tag_filter.tag_id", tag.data.id);
    expect(inner.data).toHaveLength(1);
    const none = await svc.from("contacts").select("id, tag_filter:contact_tags!inner(tag_id)").eq("tag_filter.tag_id", ids.user);
    expect(none.data).toHaveLength(0);
  });

  it("maps no-row .single() to PGRST116 and maybeSingle to null", async () => {
    const svc = db.createServiceDb();
    const a = await svc.from("contacts").select("id").eq("name", "nobody").single();
    expect(a.error?.code).toBe("PGRST116");
    const b = await svc.from("contacts").select("id").eq("name", "nobody").maybeSingle();
    expect(b.error).toBeNull();
    expect(b.data).toBeNull();
  });

  it("reports unique violations with SQLSTATE 23505", async () => {
    const svc = db.createServiceDb();
    const r = await svc.from("contacts").insert({ user_id: ids.user, account_id: ids.account, phone: "+15550001", name: "Dup" });
    expect(r.error?.code).toBe("23505");
  });

  it("updates, upserts and deletes", async () => {
    const svc = db.createServiceDb();
    const u = await svc.from("contacts").update({ name: "Ann B" }).eq("id", ids.contact).select("name").single();
    expect(u.data.name).toBe("Ann B");
    const up = await svc.from("ai_training_profiles").upsert({ account_id: ids.account, profile: { a: [1, 2] } }, { onConflict: "account_id" }).select().single();
    expect(up.data.profile).toEqual({ a: [1, 2] });
    const up2 = await svc.from("ai_training_profiles").upsert({ account_id: ids.account, profile: { b: 1 } }, { onConflict: "account_id" }).select().single();
    expect(up2.data.profile).toEqual({ b: 1 });
    const del = await svc.from("contact_tags").delete().eq("contact_id", ids.contact);
    expect(del.error).toBeNull();
  });

  it("applies row level security for the signed-in user", async () => {
    const mine = db.createUserDbFor(ids.user);
    const own = await mine.from("contacts").select("id").eq("id", ids.contact);
    expect(own.data).toHaveLength(1);
    const stranger = await pool.getPool().query("INSERT INTO public.users (email) VALUES ('s@x.com') RETURNING id");
    const other = db.createUserDbFor(stranger.rows[0].id);
    const seen = await other.from("contacts").select("id").eq("id", ids.contact);
    expect(seen.data).toHaveLength(0);
    const anon = db.createUserDbFor(null);
    expect((await anon.from("contacts").select("id")).data).toHaveLength(0);
  });

  it("calls functions with named arguments", async () => {
    const mine = db.createUserDbFor(ids.user);
    const r = await mine.rpc("is_account_member", { target_account_id: ids.account });
    expect(r.error).toBeNull();
    expect(r.data).toBe(true);
    const missing = await mine.rpc("nope", {});
    expect(missing.error?.code).toBe("PGRST202");
  });
});
